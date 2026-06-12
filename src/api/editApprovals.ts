import crypto from "node:crypto";

type PendingEdit = {
  runId: string;
  filePath: string;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
};

const pendingEditApprovals = new Map<string, PendingEdit>();

export function requestEditApproval(input: {
  runId: string;
  filePath: string;
  emit: (evt: { type: "edit_approval_required"; runId: string; filePath: string; approvalId: string }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ approvalId: string; approved: boolean }> {
  const runId = String(input.runId || "").trim();
  const filePath = String(input.filePath || "");
  const approvalId = crypto.randomUUID();
  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : 5 * 60 * 1000;

  return new Promise((resolve) => {
    const finish = (approved: boolean): void => {
      const entry = pendingEditApprovals.get(approvalId);
      if (entry) {
        try { clearTimeout(entry.timeout); } catch {}
        pendingEditApprovals.delete(approvalId);
      }
      resolve({ approvalId, approved });
    };

    const timeout = setTimeout(() => finish(false), timeoutMs);
    pendingEditApprovals.set(approvalId, { runId, filePath, resolve: finish, timeout });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) { finish(false); return; }
      const onAbort = (): void => {
        try { input.abortSignal?.removeEventListener("abort", onAbort); } catch {}
        finish(false);
      };
      try { input.abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }

    // Emit LAST — synchronous resolvers find the registered entry.
    input.emit({ type: "edit_approval_required", runId, filePath, approvalId });
  });
}

export function resolveEditApproval(input: {
  approvalId: string;
  runId: string;
  approved: boolean;
}): { ok: boolean; message?: string } {
  const approvalId = String(input.approvalId || "").trim();
  const runId = String(input.runId || "").trim();
  const entry = pendingEditApprovals.get(approvalId);
  if (!entry) return { ok: false, message: "unknown_approval_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };
  entry.resolve(!!input.approved);
  return { ok: true };
}

export function rejectPendingEditsForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  for (const [approvalId, entry] of Array.from(pendingEditApprovals.entries())) {
    if (entry.runId === runId) {
      n++;
      try { entry.resolve(false); } catch {}
      pendingEditApprovals.delete(approvalId);
      try { clearTimeout(entry.timeout); } catch {}
    }
  }
  return n;
}
