import crypto from "node:crypto";
import type { StagedFile } from "../core/fileDiff.js";

export type StagedDecision =
  | "approve_all"  // flush all staged files
  | "manual"       // per-file approval via approveFile()
  | "refine"       // discard staging, re-run with feedback
  | "reject"       // discard staging, abort run
  | "timeout";     // approval wait exceeded timeout

export interface StagedCheckpointHandler {
  run: (ctx: {
    files: StagedFile[];
    verificationSummary: string;
    trigger: "natural_completion" | "max_iterations";
  }) => Promise<{ decision: StagedDecision; feedback?: string }>;
  approveFile: (filePath: string) => Promise<boolean>;
}

type PendingStaged = {
  runId: string;
  resolve: (result: { decision: StagedDecision; feedback?: string }) => void;
  timeout: NodeJS.Timeout;
};

const pendingStagedApprovals = new Map<string, PendingStaged>();

export function requestStagedApproval(input: {
  runId: string;
  files: StagedFile[];
  verificationSummary: string;
  trigger: "natural_completion" | "max_iterations";
  emit: (evt: {
    type: "staged_diffs_ready_for_approval";
    runId: string;
    approvalId: string;
    ts: number;
    title: string;
    stagedFilesJson: string;
    stagedVerificationSummary: string;
    stagedTrigger: string;
  }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** When true, resolve immediately as "approve_all" without emission or pending state. */
  autoApprove?: boolean;
}): Promise<{ approvalId: string; decision: StagedDecision; feedback?: string }> {
  const runId = String(input.runId || "").trim();
  const approvalId = crypto.randomUUID();
  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : 10 * 60 * 1000;

  if (input.autoApprove) {
    return Promise.resolve({ approvalId, decision: "approve_all" });
  }

  return new Promise((resolve) => {
    const finish = (result: { decision: StagedDecision; feedback?: string }): void => {
      const entry = pendingStagedApprovals.get(approvalId);
      if (entry) {
        try { clearTimeout(entry.timeout); } catch {}
        pendingStagedApprovals.delete(approvalId);
      }
      resolve({ approvalId, ...result });
    };

    const timeout = setTimeout(() => finish({ decision: "timeout" }), timeoutMs);
    pendingStagedApprovals.set(approvalId, { runId, resolve: finish, timeout });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) { finish({ decision: "reject" }); return; }
      const onAbort = (): void => {
        try { input.abortSignal?.removeEventListener("abort", onAbort); } catch {}
        finish({ decision: "reject" });
      };
      try { input.abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }

    // Emit LAST — synchronous resolvers find the registered entry.
    input.emit({
      type: "staged_diffs_ready_for_approval",
      runId,
      approvalId,
      ts: Date.now(),
      title: `Review ${input.files.length} staged file(s)`,
      stagedFilesJson: JSON.stringify(input.files),
      stagedVerificationSummary: input.verificationSummary,
      stagedTrigger: input.trigger,
    });
  });
}

export function resolveStagedApproval(input: {
  approvalId: string;
  runId: string;
  decision: StagedDecision;
  feedback?: string;
}): { ok: boolean; message?: string } {
  const approvalId = String(input.approvalId || "").trim();
  const runId = String(input.runId || "").trim();
  const entry = pendingStagedApprovals.get(approvalId);
  if (!entry) return { ok: false, message: "unknown_approval_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };
  entry.resolve({ decision: input.decision, feedback: input.feedback });
  return { ok: true };
}

export function rejectPendingStagedForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  for (const [approvalId, entry] of Array.from(pendingStagedApprovals.entries())) {
    if (entry.runId === runId) {
      n++;
      try { entry.resolve({ decision: "reject" }); } catch {}
      pendingStagedApprovals.delete(approvalId);
      try { clearTimeout(entry.timeout); } catch {}
    }
  }
  return n;
}
