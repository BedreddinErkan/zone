import crypto from "node:crypto";

export const SAFE_COMMAND_PREFIXES = {
  build: [
    "npm run build",
    "yarn build",
    "tsc --noEmit",
    "tsc -p",
  ],
  test: [
    "npm run test",
    "npm test",
    "yarn test",
  ],
  readonly: [
    "ls", "cat", "find", "grep", "head", "tail", "wc",
    "node --version", "node -v", "npm --version",
    "echo",
  ],
  git: [
    "git status", "git diff", "git log",
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
  if (/[&|;`$()<>]/.test(trimmed)) return null;

  for (const [category, prefixes] of Object.entries(SAFE_COMMAND_PREFIXES)) {
    if (prefixes.some(prefix => trimmed === prefix || trimmed.startsWith(prefix + " "))) {
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

    // TEMP probe — Opus audit Step 8, remove in TUI.5.4
    console.error("[probe-approval-emit]", JSON.stringify({ runId, command: command.slice(0, 60), approvalId }));
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
