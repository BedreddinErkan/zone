import crypto from "node:crypto";
import { log } from "../utils/logger.js";
import { getRequestContext } from "../llm/openaiContext.js";
import * as registry from "../cli/interactionRegistry.js";

// Phase 6b — pending approvals delegate to the unified interaction registry.
// The private pendingApprovals Map is deleted. The trusted-commands caches stay
// here (they're session-scoped lookup tables, not pending interactions).
// Side-map: approvalId → metadata for resolve-time trust recording + finish callback.
const approvalMeta = new Map<string, { runId: string; command: string; finish: (approved: boolean, reason?: CommandDenialReason) => void }>();
const trustedCommandsByRunId = new Map<string, Set<string>>();
const trustAllByRunId = new Set<string>();

export const INVESTIGATION_SAFE_PREFIXES = {
  typecheck: ["npm run typecheck", "npm run type-check", "npm run check", "npx tsc --noEmit"],
  test_runners: ["npx vitest run", "npx vitest --run", "vitest run", "npx jest", "pnpm test"],
  lint: ["npx prettier --check"],
  git_read: ["git branch"],
} as const;

const DESTRUCTIVE_GIT_BRANCH_RE =
  /git\s+branch\s+(-[dDmMcCu]|--delete\b|--move\b|--copy\b|--set-upstream)/;

function stripTrailingBenignRedirect(cmd: string): string {
  return cmd.replace(/\s+2>(?:&1|\/dev\/null)\s*$/, "").trimEnd();
}

export function isInvestigationSafeCommand(command: string): boolean {
  const trimmed = String(command || "").trim();
  if (!trimmed) return false;
  const core = stripTrailingBenignRedirect(trimmed);
  if (/[&|;`$()<>]/.test(core)) return false;
  if (
    /(?:^|\s)\.env(\s|$)/.test(trimmed) ||
    /(?:^|\s)\.env\.(?!example(?:\s|$))/.test(trimmed) ||
    /\.zone[/\\]keys\.json/.test(trimmed) ||
    /\.zone[/\\]sessions/.test(trimmed) ||
    /(?:^|\s)[\w./]*\.(pem|key)(\s|$)/.test(trimmed) ||
    /(?:^|\s)(id_rsa|credentials)(\s|$)/.test(trimmed)
  ) return false;
  if (core.startsWith("git branch") && DESTRUCTIVE_GIT_BRANCH_RE.test(core)) return false;
  for (const prefixes of Object.values(INVESTIGATION_SAFE_PREFIXES)) {
    if ((prefixes as readonly string[]).some((p) => core === p || core.startsWith(p + " "))) return true;
  }
  return false;
}

export const SAFE_COMMAND_PREFIXES = {
  build: ["npm run build", "yarn build", "tsc --noEmit", "tsc -p", "pnpm build", "pnpm run build", "cargo check", "cargo build", "go build", "dotnet build"],
  test: ["npm run test", "npm test", "yarn test", "pnpm test", "pnpm run test", "cargo test", "go test", "mvn test", "gradle test", "./gradlew test", "dotnet test", "bundle exec rspec", "rspec", "rake test", "composer test", "phpunit", "pytest", "poetry run pytest", "uv run pytest"],
  readonly: ["ls", "cat", "find", "grep", "head", "tail", "wc", "node --version", "node -v", "npm --version", "echo", "pwd", "which"],
  git: ["git status", "git diff", "git log", "git show", "git blame", "git rev-parse"],
} as const;

export function getSafeCommandCategory(command: string): string | null {
  const trimmed = String(command || "").trim();
  if (!trimmed) return null;
  const core = stripTrailingBenignRedirect(trimmed);
  if (/[&|;`$()<>]/.test(core)) return null;
  if (
    /(?:^|\s)\.env(\s|$)/.test(trimmed) ||
    /(?:^|\s)\.env\.(?!example(?:\s|$))/.test(trimmed) ||
    /\.zone[/\\]keys\.json/.test(trimmed) ||
    /\.zone[/\\]sessions/.test(trimmed) ||
    /(?:^|\s)[\w./]*\.(pem|key)(\s|$)/.test(trimmed) ||
    /(?:^|\s)(id_rsa|credentials)(\s|$)/.test(trimmed)
  ) return null;
  for (const [category, prefixes] of Object.entries(SAFE_COMMAND_PREFIXES)) {
    if (prefixes.some(prefix => core === prefix || core.startsWith(prefix + " "))) return category;
  }
  return null;
}

export function isSafeCommand(command: string): boolean {
  return getSafeCommandCategory(command) !== null;
}

export type CommandDenialReason = "investigation_not_diagnostic" | "approval_timeout" | "run_ending";

export function isTrustAllForRun(runId: string): boolean {
  const rid = String(runId || "").trim();
  return rid ? trustAllByRunId.has(rid) : false;
}

export function setTrustAllForRun(runId: string): void {
  const rid = String(runId || "").trim();
  if (rid) trustAllByRunId.add(rid);
}

export function clearTrustAllForRun(runId: string): void {
  const rid = String(runId || "").trim();
  if (rid) trustAllByRunId.delete(rid);
}

export function isCommandTrusted(runId: string, command: string): boolean {
  const rid = String(runId || "").trim();
  const cmd = String(command || "").trim();
  if (!rid || !cmd) return false;
  if (isTrustAllForRun(rid)) return true;
  const trusted = trustedCommandsByRunId.get(rid);
  return trusted ? trusted.has(cmd) : false;
}

export function addTrustedCommand(runId: string, command: string): void {
  const rid = String(runId || "").trim();
  const cmd = String(command || "").trim();
  if (!rid || !cmd) return;
  let set = trustedCommandsByRunId.get(rid);
  if (!set) { set = new Set<string>(); trustedCommandsByRunId.set(rid, set); }
  set.add(cmd);
}

export function clearTrustedCommandsForRun(runId: string): number {
  const rid = String(runId || "").trim();
  if (!rid) return 0;
  const set = trustedCommandsByRunId.get(rid);
  const n = set ? set.size : 0;
  if (set) trustedCommandsByRunId.delete(rid);
  clearTrustAllForRun(rid);
  return n;
}

export function requestCommandApproval(input: {
  runId: string;
  command: string;
  emit: (evt: {
    type: "command_approval_required";
    runId: string;
    command: string;
    approvalId: string;
    kind?: "command" | "mcp";
    subagentId?: string;
  }) => void;
  kind?: "command" | "mcp";
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  investigationMode?: boolean;
}): Promise<{ approvalId: string; approved: boolean; reason?: CommandDenialReason }> {
  const runId = String(input.runId || "").trim();
  const command = String(input.command || "");
  const approvalId = crypto.randomUUID();
  const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : 5 * 60 * 1000;
  const kind = input.kind ?? "command";

  // Auto-approval paths — no registry interaction
  if (kind === "command" && isSafeCommand(command)) {
    try { input.emit({ type: "command_auto_approved" as any, runId, command, approvalId }); } catch {}
    return Promise.resolve({ approvalId, approved: true });
  }

  if (input.investigationMode) {
    if (isInvestigationSafeCommand(command)) {
      try { input.emit({ type: "command_auto_approved_investigation" as any, runId, command, approvalId }); } catch {}
      return Promise.resolve({ approvalId, approved: true });
    }
    // Item 190 fix: this branch previously emitted on no channel at all, unlike the two
    // approving branches above — an emit (matching their shape) plus a marker
    // (matching run_command_readonly's own [zone-run-command-readonly-blocked], the sibling
    // gate's blocked marker) make the denial observable on both the live event bus and the
    // persisted marker sink.
    try {
      input.emit({ type: "command_denied_investigation", runId, command, approvalId, reason: "investigation_not_diagnostic" } as any);
    } catch {}
    log("[zone-investigation-command-denied]", JSON.stringify({ runId, command: command.slice(0, 200), reason: "investigation_not_diagnostic" }));
    return Promise.resolve({ approvalId, approved: false, reason: "investigation_not_diagnostic" });
  }

  if (isCommandTrusted(runId, command)) {
    try { input.emit({ type: "command_trusted" as any, runId, command, approvalId }); } catch {}
    return Promise.resolve({ approvalId, approved: true });
  }

  // Pending approval path — delegates to the unified registry for storage/abort-cleanup
  // but manages its own timeout (to distinguish "approval_timeout" from "run_ending").
  return new Promise((resolve) => {
    const meta = { runId, command, finish: null as any };
    approvalMeta.set(approvalId, meta);

    let settled = false;
    const finish = (approved: boolean, reason?: CommandDenialReason): void => {
      if (settled) return;
      settled = true;
      approvalMeta.delete(approvalId);
      clearTimeout(markerTimer);
      clearTimeout(timeoutTimer);
      // Remove from registry if still there
      registry.abort("command_approval", approvalId);
      resolve({ approvalId, approved, reason });
    };
    meta.finish = finish;

    // Timeout: emit marker + resolve with "approval_timeout" reason
    const markerTimer = setTimeout(() => {
      try {
        input.emit({ type: "command_denied_timeout", runId, command, approvalId, reason: "approval_timeout" } as any);
      } catch {}
      log("[zone-command-approval-timeout]", JSON.stringify({ runId, command: command.slice(0, 200), reason: "approval_timeout" }));
    }, timeoutMs);
    const timeoutTimer = setTimeout(() => finish(false, "approval_timeout"), timeoutMs);

    // Register in the unified registry for abortAll cleanup. The registry's resolve
    // callback is a no-op — we manage timeout/abort reasons ourselves.
    registry.request("command_approval", approvalId, {
      runId,
      resolve: () => { /* resolved by finish() */ },
      abortSignal: input.abortSignal,
    });

    if (!registry._hasPending("command_approval", approvalId)) {
      // Already aborted synchronously
      finish(false, "run_ending");
      return;
    }

    // Wire abort signal to resolve with "run_ending" reason
    if (input.abortSignal) {
      const onAbort = (): void => {
        try { input.abortSignal?.removeEventListener("abort", onAbort); } catch {}
        finish(false, "run_ending");
      };
      try { input.abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }

    // Phase 5c — enrich with subagentId from ALS
    const subagentId = getRequestContext()?.subagentId;
    input.emit({
      type: "command_approval_required",
      runId,
      command,
      approvalId,
      ...(kind !== "command" ? { kind } : {}),
      ...(subagentId ? { subagentId } : {}),
    });
  });
}

export function resolveCommandApproval(input: {
  approvalId: string;
  approved: boolean;
  runId: string;
  trust?: boolean;
}): { ok: boolean; message?: string } {
  const approvalId = String(input.approvalId || "").trim();
  const approved = !!input.approved;
  if (!approvalId) return { ok: false, message: "unknown_approval_id" };
  const meta = approvalMeta.get(approvalId);
  if (!meta) return { ok: false, message: "unknown_approval_id" };
  // Record trust BEFORE calling finish (which deletes the meta)
  if (approved && input.trust) {
    addTrustedCommand(meta.runId, meta.command);
  }
  // Call finish directly — it handles cleanup (timers, registry, meta) and resolves the Promise
  meta.finish(approved);
  return { ok: true };
}

export function rejectPendingApprovalsForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  // Iterate the meta side-map to find entries for this run and call their finish functions
  for (const [id, meta] of Array.from(approvalMeta.entries())) {
    if (meta.runId === runId) {
      n++;
      meta.finish(false, "run_ending");
    }
  }
  return n;
}

export { resolvePlanApproval, type PlanDecision } from "../llm/planApprovals.js";
export { resolveEditApproval } from "./editApprovals.js";
