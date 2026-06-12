type PendingTrust = {
  runId: string;
  projectPath: string;
  resolve: (ok: boolean) => void;
  timeout: NodeJS.Timeout;
};

const pendingTrusts = new Map<string, PendingTrust>(); // key = runId (one trust approval per run)

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
      const entry = pendingTrusts.get(runId);
      if (entry) {
        try { clearTimeout(entry.timeout); } catch {}
        pendingTrusts.delete(runId);
      }
      resolve(ok);
    };

    const timeout = setTimeout(() => finish(false), timeoutMs);
    pendingTrusts.set(runId, { runId, projectPath, resolve: finish, timeout });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) { finish(false); return; }
      const onAbort = (): void => {
        try { input.abortSignal?.removeEventListener("abort", onAbort); } catch {}
        finish(false);
      };
      try { input.abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }

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
  const entry = pendingTrusts.get(runIdStr);
  if (!entry) return { ok: false, message: "unknown_run_id" };
  entry.resolve(!!ok);
  return { ok: true };
}

export function rejectPendingTrustForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  const entry = pendingTrusts.get(runId);
  if (entry) {
    n++;
    try { entry.resolve(false); } catch {}
    pendingTrusts.delete(runId);
    try { clearTimeout(entry.timeout); } catch {}
  }
  return n;
}
