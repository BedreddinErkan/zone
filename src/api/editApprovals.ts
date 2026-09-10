import crypto from "node:crypto";
import * as registry from "../cli/interactionRegistry.js";

// Phase 6b — delegates to the unified interaction registry.
// The private Map singleton is deleted; the public API is preserved unchanged.

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
      resolve({ approvalId, approved });
    };

    registry.request("edit_approval", approvalId, {
      runId,
      resolve: finish,
      abortSignal: input.abortSignal,
      timeoutMs,
      timeoutResult: false,
    });

    // If already aborted, the registry resolved synchronously — skip emit
    if (!registry._hasPending("edit_approval", approvalId)) return;

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
  if (!approvalId) return { ok: false, message: "unknown_approval_id" };
  const resolved = registry.resolve("edit_approval", approvalId, !!input.approved);
  return resolved ? { ok: true } : { ok: false, message: "unknown_approval_id" };
}

export function rejectPendingEditsForRun(runIdRaw: string): number {
  return registry.rejectByKindAndRun("edit_approval", runIdRaw);
}
