import crypto from "node:crypto";

const SAFE_COMMAND_PREFIXES = [
  "npm run build", "npm run test", "npm test",
  "yarn build", "yarn test",
  "ls", "cat", "find", "grep", "head", "tail", "wc",
  "git status", "git diff", "git log",
  "tsc --noEmit", "tsc -p",
  "node --version", "node -v", "npm --version",
  "echo",
];

/**
 * Returns true if `command` exactly matches a safe prefix or starts with `<prefix> `.
 * Returns false if the command contains shell metacharacters that could chain
 * dangerous operations (e.g. "ls && rm -rf /").
 */
export function isSafeCommand(command: string): boolean {
  const trimmed = String(command || "").trim();
  if (!trimmed) return false;
  if (/[&|;`$()<>]/.test(trimmed)) return false;
  return SAFE_COMMAND_PREFIXES.some(prefix =>
    trimmed === prefix || trimmed.startsWith(prefix + " ")
  );
}

type PendingApproval = {
  runId: string;
  command: string;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
};

const pendingApprovals = new Map<string, PendingApproval>();
const trustedCommandsByRunId = new Map<string, Set<string>>();

/**
 * True if `command` (trimmed) was previously approved with `trust: true`
 * for this runId.
 */
export function isCommandTrusted(runId: string, command: string): boolean {
  const rid = String(runId || "").trim();
  const cmd = String(command || "").trim();
  if (!rid || !cmd) return false;
  const trusted = trustedCommandsByRunId.get(rid);
  return trusted ? trusted.has(cmd) : false;
}

/**
 * Add `command` to the trusted set for this runId. No-op for empty inputs.
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
  if (!set) return 0;
  const n = set.size;
  trustedCommandsByRunId.delete(rid);
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

  input.emit({ type: "command_approval_required", runId, command, approvalId });

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
