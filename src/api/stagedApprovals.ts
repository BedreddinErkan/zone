import crypto from "node:crypto";
import type { StagedFile } from "../core/fileDiff.js";
import * as registry from "../cli/interactionRegistry.js";

// Phase 6b — delegates to the unified interaction registry.

export type StagedDecision =
  | "approve_all"
  | "manual"
  | "refine"
  | "reject"
  | "timeout";

export interface StagedCheckpointHandler {
  run: (ctx: {
    files: StagedFile[];
    verificationSummary: string;
    trigger: "natural_completion" | "max_iterations";
  }) => Promise<{ decision: StagedDecision; feedback?: string }>;
  approveFile: (filePath: string) => Promise<boolean>;
}

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
      resolve({ approvalId, ...result });
    };

    stagedRunIds.set(approvalId, runId);
    registry.request("staged_diff", approvalId, {
      runId,
      resolve: (result: any) => { stagedRunIds.delete(approvalId); finish(result); },
      abortSignal: input.abortSignal,
      timeoutMs,
      timeoutResult: { decision: "timeout" as StagedDecision },
      abortResult: { decision: "reject" as StagedDecision },
    });

    if (!registry._hasPending("staged_diff", approvalId)) {
      // Already aborted — resolve with reject
      resolve({ approvalId, decision: "reject" });
      return;
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

// Side-map for runId validation
const stagedRunIds = new Map<string, string>();

export function resolveStagedApproval(input: {
  approvalId: string;
  runId: string;
  decision: StagedDecision;
  feedback?: string;
}): { ok: boolean; message?: string } {
  const approvalId = String(input.approvalId || "").trim();
  const runId = String(input.runId || "").trim();
  if (!approvalId) return { ok: false, message: "unknown_approval_id" };
  const storedRunId = stagedRunIds.get(approvalId);
  if (!storedRunId) return { ok: false, message: "unknown_approval_id" };
  if (runId && storedRunId && runId !== storedRunId) return { ok: false, message: "run_id_mismatch" };
  const resolved = registry.resolve("staged_diff", approvalId, {
    decision: input.decision,
    feedback: input.feedback,
  });
  if (resolved) stagedRunIds.delete(approvalId);
  return resolved ? { ok: true } : { ok: false, message: "unknown_approval_id" };
}

export function rejectPendingStagedForRun(runIdRaw: string): number {
  return registry.rejectByKindAndRun("staged_diff", runIdRaw);
}
