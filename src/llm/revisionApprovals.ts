/**
 * Scope revision approval gate.
 * Phase 6b — delegates to the unified interaction registry.
 */

import crypto from "node:crypto";
import * as registry from "../cli/interactionRegistry.js";

export interface RevisionProposal {
  runId: string;
  type: "under_scope" | "over_scope" | "mixed";
  reason: string;
  originalPlan: string;
  revisedPlanSummary: string;
  missingFiles?: string[];
  unnecessaryFiles?: string[];
}

export type RevisionDecision = "approve" | "reject" | "auto_apply" | "timeout";

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

  return new Promise((resolve) => {
    const finish = (decision: RevisionDecision): void => {
      resolve({ revisionId, decision });
    };

    revisionRunIds.set(revisionId, proposal.runId);
    registry.request("plan_revision", revisionId, {
      runId: proposal.runId,
      resolve: (decision: any) => { revisionRunIds.delete(revisionId); finish(decision); },
      abortSignal: input.abortSignal,
      timeoutMs,
      timeoutResult: "timeout" as RevisionDecision,
      abortResult: "reject" as RevisionDecision,
    });

    if (!registry._hasPending("plan_revision", revisionId)) {
      resolve({ revisionId, decision: "reject" });
      return;
    }

    // Emit LAST — synchronous resolvers find the registered entry.
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
  });
}

// Side-map for runId validation
const revisionRunIds = new Map<string, string>();

export function resolveRevisionApproval(input: {
  revisionId: string;
  runId: string;
  decision: RevisionDecision;
}): { ok: boolean; message?: string } {
  const revisionId = String(input.revisionId || "").trim();
  const runId = String(input.runId || "").trim();
  if (!revisionId) return { ok: false, message: "unknown_revision_id" };
  const storedRunId = revisionRunIds.get(revisionId);
  if (!storedRunId) return { ok: false, message: "unknown_revision_id" };
  if (runId && storedRunId && runId !== storedRunId) return { ok: false, message: "run_id_mismatch" };
  const resolved = registry.resolve("plan_revision", revisionId, input.decision);
  if (resolved) revisionRunIds.delete(revisionId);
  return resolved ? { ok: true } : { ok: false, message: "unknown_revision_id" };
}

export function rejectPendingRevisionsForRun(runIdRaw: string): number {
  return registry.rejectByKindAndRun("plan_revision", runIdRaw);
}
