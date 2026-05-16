/**
 * Phase AS: scope revision approval gate.
 * Emitted between plan generation and execute when investigateScope detects
 * a scope mismatch. User approves or rejects; original plan is unchanged
 * on reject (execution proceeds with the original approved plan).
 */

import crypto from "node:crypto";

export interface RevisionProposal {
  runId: string;
  type: "under_scope" | "over_scope" | "mixed";
  reason: string;
  originalPlan: string;
  revisedPlanSummary: string;
  missingFiles?: string[];
  unnecessaryFiles?: string[];
}

/** Y.0: "auto_apply" is emitted when a minor mismatch is silently applied
 *  (plan review off + severity=minor). UI shows a log line; no user prompt.
 *  Y.1.2: "timeout" is emitted when the approval wait exceeds the configured
 *  timeout — distinct from "reject" so callers can return revision_approval_timeout. */
export type RevisionDecision = "approve" | "reject" | "auto_apply" | "timeout";

type PendingRevision = {
  runId: string;
  proposal: RevisionProposal;
  resolve: (decision: RevisionDecision) => void;
  timeout: NodeJS.Timeout;
};

const pendingRevisions = new Map<string, PendingRevision>();

export function requestRevisionApproval(input: {
  proposal: RevisionProposal;
  emit: (evt: {
    type: "scope_revision_proposed";
    runId: string;
    revisionId: string;
    revisionType: RevisionProposal["type"];
    revisionReason: string;
    revisionOriginalPlan: string;
    revisionRevisedPlanSummary: string;
    revisionMissingFiles?: string[];
    revisionUnnecessaryFiles?: string[];
  }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Y.1.1: when true, resolve immediately as "approve" without SSE emission or pending state. */
  autoApprove?: boolean;
}): Promise<{ revisionId: string; decision: RevisionDecision }> {
  const revisionId = crypto.randomUUID();

  if (input.autoApprove) {
    return Promise.resolve({ revisionId, decision: "approve" });
  }

  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0
      ? input.timeoutMs
      : 10 * 60 * 1000;
  const { proposal } = input;

  input.emit({
    type: "scope_revision_proposed",
    runId: proposal.runId,
    revisionId,
    revisionType: proposal.type,
    revisionReason: proposal.reason,
    revisionOriginalPlan: proposal.originalPlan,
    revisionRevisedPlanSummary: proposal.revisedPlanSummary,
    ...(proposal.missingFiles ? { revisionMissingFiles: proposal.missingFiles } : {}),
    ...(proposal.unnecessaryFiles ? { revisionUnnecessaryFiles: proposal.unnecessaryFiles } : {}),
  });

  return new Promise((resolve) => {
    const finish = (decision: RevisionDecision) => {
      const entry = pendingRevisions.get(revisionId);
      if (entry) {
        try { clearTimeout(entry.timeout); } catch {}
        pendingRevisions.delete(revisionId);
      }
      resolve({ revisionId, decision });
    };

    const timeout = setTimeout(() => finish("timeout"), timeoutMs);
    pendingRevisions.set(revisionId, { runId: proposal.runId, proposal, resolve: finish, timeout });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        finish("reject");
        return;
      }
      const onAbort = () => {
        try { input.abortSignal?.removeEventListener("abort", onAbort as () => void); } catch {}
        finish("reject");
      };
      try { input.abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }
  });
}

export function resolveRevisionApproval(input: {
  revisionId: string;
  runId: string;
  decision: RevisionDecision;
}): { ok: boolean; message?: string } {
  const revisionId = String(input.revisionId || "").trim();
  const runId = String(input.runId || "").trim();
  const entry = pendingRevisions.get(revisionId);
  if (!entry) return { ok: false, message: "unknown_revision_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };
  entry.resolve(input.decision);
  return { ok: true };
}

export function rejectPendingRevisionsForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  for (const [revisionId, entry] of Array.from(pendingRevisions.entries())) {
    if (entry.runId === runId) {
      n += 1;
      try { entry.resolve("reject"); } catch {}
      pendingRevisions.delete(revisionId);
      try { clearTimeout(entry.timeout); } catch {}
    }
  }
  return n;
}
