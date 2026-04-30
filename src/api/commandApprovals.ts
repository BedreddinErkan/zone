import crypto from "node:crypto";

type PendingApproval = {
  runId: string;
  command: string;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
};

const pendingApprovals = new Map<string, PendingApproval>();

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
}): { ok: boolean; message?: string } {
  const approvalId = String(input.approvalId || "").trim();
  const approved = !!input.approved;
  const runId = String(input.runId || "").trim();
  const entry = pendingApprovals.get(approvalId);
  if (!entry) return { ok: false, message: "unknown_approval_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };
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

