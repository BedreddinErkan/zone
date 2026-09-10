/**
 * Plan-ready approval gate.
 * Phase 6b — delegates to the unified interaction registry.
 */

import { log } from "../utils/logger.js";
import * as registry from "../cli/interactionRegistry.js";

export interface PlanReadyProposal {
  runId: string;
  planId: string;
  objective?: string;
  steps: Array<{ title: string; description: string; filesLikely: string[]; subagentEligible?: boolean }>;
  scopeNotes?: string;
  noChangeReason?: string;
  cannotVerifyReason?: string;
  answerOnlyReason?: string;
  riskHints?: string[];
  scopeSummary?: string;
  narrative?: string;
  filesLikely?: string[];
}

export function emitPlanEmptyApproval(data: {
  runId: string;
  reasonField: "noChangeReason" | "cannotVerifyReason" | "answerOnlyReason" | "unknown";
  reviewed: boolean;
}): void {
  // `log()`, matching `[zone-tier-grant-unusable]` (loopTelemetry.ts) — fires
  // unconditionally, no ZONE_VERBOSE_LOGS gate. This is diagnostic only: it does
  // not change what happens next, and it does not itself make the count
  // queryable — see the commit message for what that claim does and does not
  // cover.
  log("[zone-plan-empty-approval]", JSON.stringify(data));
}

export type PlanDecision =
  | "accept_all"
  | "manual"
  | "refine"
  | "feedback"
  | "approve_with_feedback"
  | "reject"
  | "timeout";

export function requestPlanApproval(input: {
  proposal: PlanReadyProposal;
  emit: (evt: {
    type: "plan_ready_for_approval";
    runId: string;
    ts: number;
    title: string;
    planId: string;
    planObjective?: string;
    planStepsJson: string;
    planScopeNotes?: string;
    planNoChangeReason?: string;
    planCannotVerifyReason?: string;
    planAnswerOnlyReason?: string;
    planRiskHints?: string[];
    planScopeSummary?: string;
    planNarrative?: string;
    planFilesLikely?: string[];
  }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  autoApprove?: boolean;
}): Promise<{ planId: string; decision: PlanDecision; feedback?: string; modalEmitted: boolean }> {
  const { proposal } = input;
  const planId = proposal.planId;

  if (input.autoApprove) {
    return Promise.resolve({ planId, decision: "accept_all", modalEmitted: false });
  }

  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0
      ? input.timeoutMs
      : 10 * 60 * 1000;

  return new Promise((resolve) => {
    let modalEmitted = false;
    const finish = (result: { decision: PlanDecision; feedback?: string }): void => {
      resolve({ planId, decision: result.decision, feedback: result.feedback, modalEmitted });
    };

    planRunIds.set(planId, proposal.runId);
    registry.request("plan_ready", planId, {
      runId: proposal.runId,
      resolve: (result: any) => { planRunIds.delete(planId); finish(result); },
      abortSignal: input.abortSignal,
      timeoutMs,
      timeoutResult: { decision: "timeout" as PlanDecision },
      abortResult: { decision: "reject" as PlanDecision },
    });

    if (!registry._hasPending("plan_ready", planId)) {
      finish({ decision: "reject" });
      return;
    }

    // Emit LAST — synchronous resolvers find the registered entry.
    input.emit({
      type: "plan_ready_for_approval",
      runId: proposal.runId,
      ts: Date.now(),
      title: `Plan ready: ${(proposal.objective ?? "").slice(0, 80)}`,
      planId,
      planObjective: proposal.objective,
      planStepsJson: JSON.stringify(proposal.steps),
      planRiskHints: proposal.riskHints,
      planScopeSummary: proposal.scopeSummary,
      ...(proposal.scopeNotes ? { planScopeNotes: proposal.scopeNotes } : {}),
      ...(proposal.noChangeReason ? { planNoChangeReason: proposal.noChangeReason } : {}),
      ...(proposal.cannotVerifyReason ? { planCannotVerifyReason: proposal.cannotVerifyReason } : {}),
      ...(proposal.answerOnlyReason ? { planAnswerOnlyReason: proposal.answerOnlyReason } : {}),
      ...(proposal.narrative ? { planNarrative: proposal.narrative } : {}),
      ...(proposal.filesLikely?.length ? { planFilesLikely: proposal.filesLikely } : {}),
    });
    modalEmitted = true;
  });
}

// Side-map for runId validation
const planRunIds = new Map<string, string>();

export function resolvePlanApproval(input: {
  planId: string;
  runId: string;
  decision: PlanDecision;
  feedback?: string;
}): { ok: boolean; message?: string } {
  const planId = String(input.planId || "").trim();
  const runId = String(input.runId || "").trim();
  if (!planId) return { ok: false, message: "unknown_plan_id" };
  const storedRunId = planRunIds.get(planId);
  if (!storedRunId) return { ok: false, message: "unknown_plan_id" };
  if (runId && storedRunId && runId !== storedRunId) return { ok: false, message: "run_id_mismatch" };
  const resolved = registry.resolve("plan_ready", planId, {
    decision: input.decision,
    feedback: input.feedback,
  });
  if (resolved) planRunIds.delete(planId);
  return resolved ? { ok: true } : { ok: false, message: "unknown_plan_id" };
}

export function rejectPendingPlansForRun(runIdRaw: string): number {
  return registry.rejectByKindAndRun("plan_ready", runIdRaw);
}
