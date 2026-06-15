import crypto from "node:crypto";

/**
 * Additional prefixes auto-approved ONLY during plan-mode investigation
 * (requestCommandApproval called with investigationMode:true).
 *
 * Rationale for each entry / exclusions:
 *  - typecheck: deterministic read-only type checks; `npx tsc --noEmit` preferred over
 *    bare `npx tsc` (which writes JS output when noEmit is not in the tsconfig).
 *  - test_runners: agent cannot edit files so test runs are safe diagnostics.
 *  - lint: prettier --check is safe; `--check` is PART OF the prefix so `prettier --write`
 *    never matches. `npx eslint` deliberately excluded — `--fix` rewrites files.
 *    `npm run lint` excluded for the same reason (may alias `eslint --fix`).
 *  - git_read: `git branch` useful for listing branches; guarded below against
 *    destructive flags (-d/-D/-m/-M etc.) that don't involve shell metacharacters.
 *  - rg/fd deliberately excluded: `-x/--exec/--exec-batch` (fd) and `--pre` (rg)
 *    run arbitrary sub-commands without metacharacters; investigation already
 *    has search_in_files + grep/find for searching.
 */
export const INVESTIGATION_SAFE_PREFIXES = {
  typecheck: [
    "npm run typecheck",
    "npm run type-check",
    "npm run check",
    "npx tsc --noEmit",
  ],
  test_runners: [
    "npx vitest run",
    "npx vitest --run",
    "vitest run",
    "npx jest",
    "pnpm test",
  ],
  lint: [
    "npx prettier --check",
  ],
  git_read: [
    "git branch",
  ],
} as const;

/** Destructive git-branch flag pattern — same as runCommandSafe.ts:71. */
const DESTRUCTIVE_GIT_BRANCH_RE =
  /git\s+branch\s+(-[dDmMcCu]|--delete\b|--move\b|--copy\b|--set-upstream)/;

/**
 * Strip a trailing benign stderr redirect from a command so that an otherwise
 * safe command like `npm run build 2>&1` is treated as `npm run build` by the
 * metachar guard and prefix match. Only strips ONE trailing occurrence of
 * `2>&1` or `2>/dev/null`; leaves everything else (pipes, `>file`, `&&`) intact.
 */
function stripTrailingBenignRedirect(cmd: string): string {
  return cmd.replace(/\s+2>(?:&1|\/dev\/null)\s*$/, "").trimEnd();
}

/**
 * Returns true when `command` is auto-approvable during plan-mode investigation:
 * passes the same metachar + BYOK2 guards as {@link getSafeCommandCategory}, then
 * matches against {@link INVESTIGATION_SAFE_PREFIXES} with targeted flag guards
 * for known write/exec vectors.
 */
export function isInvestigationSafeCommand(command: string): boolean {
  const trimmed = String(command || "").trim();
  if (!trimmed) return false;
  // Strip trailing benign redirect before metachar check + prefix match (same as
  // getSafeCommandCategory). BYOK sensitive-path check stays on original `trimmed`.
  const core = stripTrailingBenignRedirect(trimmed);
  // Same metachar guard as getSafeCommandCategory.
  if (/[&|;`$()<>]/.test(core)) return false;
  // Same BYOK2 sensitive-path guard.
  if (
    /(?:^|\s)\.env(\s|$)/.test(trimmed) ||
    /(?:^|\s)\.env\.(?!example(?:\s|$))/.test(trimmed) ||
    /\.zone[/\\]keys\.json/.test(trimmed) ||
    /\.zone[/\\]sessions/.test(trimmed) ||
    /(?:^|\s)[\w./]*\.(pem|key)(\s|$)/.test(trimmed) ||
    /(?:^|\s)(id_rsa|credentials)(\s|$)/.test(trimmed)
  ) {
    return false;
  }
  // git branch: guard against destructive flags before prefix match.
  if (core.startsWith("git branch") && DESTRUCTIVE_GIT_BRANCH_RE.test(core)) {
    return false;
  }
  for (const prefixes of Object.values(INVESTIGATION_SAFE_PREFIXES)) {
    if ((prefixes as readonly string[]).some(
      (p) => core === p || core.startsWith(p + " "),
    )) {
      return true;
    }
  }
  return false;
}

export const SAFE_COMMAND_PREFIXES = {
  build: [
    "npm run build",
    "yarn build",
    "tsc --noEmit",
    "tsc -p",
    "pnpm build",
    "pnpm run build",
  ],
  test: [
    "npm run test",
    "npm test",
    "yarn test",
    "pnpm test",
    "pnpm run test",
  ],
  readonly: [
    "ls", "cat", "find", "grep", "head", "tail", "wc",
    "node --version", "node -v", "npm --version",
    "echo", "pwd", "which",
  ],
  git: [
    "git status", "git diff", "git log",
    "git show", "git blame", "git rev-parse",
  ],
} as const;

/**
 * Checks whether a command is auto-approvable by rejecting shell metacharacters
 * such as `&`, `|`, `;`, backticks, subshell syntax, or redirection, then
 * allowing only commands that exactly match a SAFE_COMMAND_PREFIXES entry or
 * begin with that prefix followed by a space.
 *
 * @param command Raw shell command text to evaluate.
 * @returns `true` when the trimmed command is non-empty, contains no rejected
 * shell metacharacters, and exactly matches or starts with an allowed
 * SAFE_COMMAND_PREFIXES entry; otherwise `false`.
 */
export function getSafeCommandCategory(command: string): string | null {
  const trimmed = String(command || "").trim();
  if (!trimmed) return null;
  // Strip a trailing benign stderr redirect before metachar check + prefix match,
  // so `npm run build 2>&1` is treated as `npm run build`. BYOK sensitive-path
  // check stays on the original `trimmed` so it cannot be redirected around.
  const core = stripTrailingBenignRedirect(trimmed);
  if (/[&|;`$()<>]/.test(core)) return null;

  // BYOK2: block sensitive-path arguments even for whitelisted prefixes
  if (
    /(?:^|\s)\.env(\s|$)/.test(trimmed) ||
    /(?:^|\s)\.env\.(?!example(?:\s|$))/.test(trimmed) ||
    /\.zone[/\\]keys\.json/.test(trimmed) ||
    /\.zone[/\\]sessions/.test(trimmed) ||
    /(?:^|\s)[\w./]*\.(pem|key)(\s|$)/.test(trimmed) ||
    /(?:^|\s)(id_rsa|credentials)(\s|$)/.test(trimmed)
  ) {
    return null;
  }

  for (const [category, prefixes] of Object.entries(SAFE_COMMAND_PREFIXES)) {
    if (prefixes.some(prefix => core === prefix || core.startsWith(prefix + " "))) {
      return category;
    }
  }

  return null;
}

/**
 * Returns whether the provided command is considered safe for automatic
 * approval by delegating to {@link getSafeCommandCategory}.
 *
 * @param command Raw shell command text to evaluate.
 * @returns `true` when the command matches one of the allowed safe-command
 * categories; otherwise `false`.
 */
export function isSafeCommand(command: string): boolean {
  return getSafeCommandCategory(command) !== null;
}

type PendingApproval = {
  runId: string;
  command: string;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
};

const pendingApprovals = new Map<string, PendingApproval>();
const trustedCommandsByRunId = new Map<string, Set<string>>();
const trustAllByRunId = new Set<string>();

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

/**
 * Checks the in-memory trusted-command state for a specific runId to see
 * whether this run trusts all commands, or whether this exact trimmed command
 * was previously approved with `trust: true` during the current run.
 *
 * @param runId Run identifier whose trust map entry should be consulted.
 * @param command Command text to trim and look up in that run-scoped trusted set.
 * @returns `true` when both inputs are non-empty after trimming and the run
 * trusts all commands or the exact command exists in the trusted set for that
 * runId; otherwise `false`.
 */
export function isCommandTrusted(runId: string, command: string): boolean {
  const rid = String(runId || "").trim();
  const cmd = String(command || "").trim();
  if (!rid || !cmd) return false;
  if (isTrustAllForRun(rid)) return true;
  const trusted = trustedCommandsByRunId.get(rid);
  return trusted ? trusted.has(cmd) : false;
}

/**
 * Records a command in the trusted set for a run after an approval is accepted
 * with `trust: true`, so later identical commands in that same run can bypass
 * another approval prompt. This trust only lives in memory until the run ends
 * or its trusted entries are cleared.
 *
 * @param runId Run identifier whose trusted-command set should be updated.
 * @param command Command text to trim and store for the lifetime of that run.
 * @returns Nothing. The command is stored only for the current in-memory run;
 * if either input is empty after trimming, nothing is added.
 */
export function addTrustedCommand(runId: string, command: string): void {
  const rid = String(runId || "").trim();
  const cmd = String(command || "").trim();
  if (!rid || !cmd) return;
  let set = trustedCommandsByRunId.get(rid);
  if (!set) {
    set = new Set<string>();
    trustedCommandsByRunId.set(rid, set);
  }
  set.add(cmd);
}

/**
 * Remove all trusted commands for this runId. Returns count removed.
 * Call at run abort/end to prevent memory leak.
 */
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
  }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /**
   * When true, the caller is a plan-mode investigation agent (runPlanInvestigation).
   * Commands that match {@link INVESTIGATION_SAFE_PREFIXES} are auto-approved; all
   * other non-safe commands are denied immediately without prompting the user.
   * (Investigation is a background planning phase — modal interruptions break UX
   * and the agent has no write tools, making non-diagnostic commands unnecessary.)
   */
  investigationMode?: boolean;
}): Promise<{ approvalId: string; approved: boolean }> {
  const runId = String(input.runId || "").trim();
  const command = String(input.command || "");
  const approvalId = crypto.randomUUID();
  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : 5 * 60 * 1000;

  if (isSafeCommand(command)) {
    // Emit transparency event so UI timeline can show what was auto-approved
    try {
      input.emit({
        type: "command_auto_approved" as any,
        runId,
        command,
        approvalId,
      });
    } catch {}
    return Promise.resolve({ approvalId, approved: true });
  }

  if (input.investigationMode) {
    if (isInvestigationSafeCommand(command)) {
      try {
        input.emit({
          type: "command_auto_approved_investigation" as any,
          runId,
          command,
          approvalId,
        });
      } catch {}
      return Promise.resolve({ approvalId, approved: true });
    }
    // Non-diagnostic command in investigation: deny immediately, no user prompt.
    // The investigation agent has no write tools — a denied non-diagnostic command
    // should make it fall back to read_file / search_in_files.
    return Promise.resolve({ approvalId, approved: false });
  }

  if (isCommandTrusted(runId, command)) {
    try {
      input.emit({
        type: "command_trusted" as any,
        runId,
        command,
        approvalId,
      });
    } catch {}
    return Promise.resolve({ approvalId, approved: true });
  }

  return new Promise((resolve) => {
    const finish = (approved: boolean) => {
      const entry = pendingApprovals.get(approvalId);
      if (entry) {
        try {
          clearTimeout(entry.timeout);
        } catch {}
        pendingApprovals.delete(approvalId);
      }
      resolve({ approvalId, approved });
    };

    const timeout = setTimeout(() => finish(false), timeoutMs);
    pendingApprovals.set(approvalId, { runId, command, resolve: finish, timeout });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        finish(false);
        return;
      }
      const onAbort = () => {
        try {
          input.abortSignal?.removeEventListener("abort", onAbort as any);
        } catch {}
        finish(false);
      };
      try {
        input.abortSignal.addEventListener("abort", onAbort, { once: true });
      } catch {}
    }

    // Emit LAST — synchronous resolvers (e.g. TUI bus) find the registered entry.
    input.emit({ type: "command_approval_required", runId, command, approvalId });
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
  const runId = String(input.runId || "").trim();
  const entry = pendingApprovals.get(approvalId);
  if (!entry) return { ok: false, message: "unknown_approval_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };
  if (approved && input.trust) {
    addTrustedCommand(entry.runId, entry.command);
  }
  entry.resolve(approved);
  return { ok: true };
}

export function rejectPendingApprovalsForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  for (const [approvalId, entry] of Array.from(pendingApprovals.entries())) {
    if (entry.runId === runId) {
      n += 1;
      try {
        entry.resolve(false);
      } catch {}
      pendingApprovals.delete(approvalId);
      try {
        clearTimeout(entry.timeout);
      } catch {}
    }
  }
  return n;
}

export { resolvePlanApproval, type PlanDecision } from "../llm/planApprovals.js";
export { resolveEditApproval } from "./editApprovals.js";
