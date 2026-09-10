import * as registry from "../cli/interactionRegistry.js";

// Phase 6b — delegates to the unified interaction registry.
// Key is runId (one trust approval per run), not a UUID.

export function requestTrustApproval(input: {
  runId: string;
  projectPath: string;
  emit: (evt: {
    type: "trust_approval_required";
    runId: string;
    ts: number;
    title: string;
    projectPath: string;
    approvalId: string;
  }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<boolean> {
  const runId = String(input.runId || "").trim();
  const projectPath = String(input.projectPath || "");
  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : 5 * 60 * 1000;

  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      resolve(ok);
    };

    registry.request("trust", runId, {
      runId,
      resolve: finish,
      abortSignal: input.abortSignal,
      timeoutMs,
      timeoutResult: false,
    });

    if (!registry._hasPending("trust", runId)) return;

    // Emit LAST — synchronous resolvers find the registered entry.
    input.emit({
      type: "trust_approval_required",
      runId,
      ts: Date.now(),
      title: "Trust this folder?",
      projectPath,
      approvalId: runId,
    });
  });
}

export function resolveTrustApproval(runId: string, ok: boolean): { ok: boolean; message?: string } {
  const runIdStr = String(runId || "").trim();
  if (!runIdStr) return { ok: false, message: "unknown_run_id" };
  const resolved = registry.resolve("trust", runIdStr, !!ok);
  return resolved ? { ok: true } : { ok: false, message: "unknown_run_id" };
}

export function rejectPendingTrustForRun(runIdRaw: string): number {
  return registry.rejectByKindAndRun("trust", runIdRaw);
}
