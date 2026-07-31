/**
 * Plan-ready approval gate.
 * Emitted after plan generation when ZONE_PLAN_APPROVAL_CYCLE=1.
 * User chooses how to proceed before execution begins.
 */

import crypto from "node:crypto";
import { log } from "../utils/logger.js";

export interface PlanReadyProposal {
  runId: string;
  planId: string;
  objective: string;
  steps: Array<{ title: string; description: string; filesLikely: string[]; subagentEligible?: boolean }>;
  scopeNotes?: string;
  noChangeReason?: string;
  cannotVerifyReason?: string;
  answerOnlyReason?: string;
  riskHints: string[];
  scopeSummary: string;
}

/**
 * A stepless (`noChangeReason`/`cannotVerifyReason`) plan reached this gate.
 *
 * The three gates that normally guarantee non-empty steps before the plan-first
 * loop starts (E8a, E8b, the forceSteps/synthesizeMinimalPlan safety net —
 * dispatch.ts) do not re-run after a replan. `reviewed` separates the two ways
 * this can happen: `feedback`/`refine` loop back into `requestPlanApproval`, so
 * the user sees it; `approve_with_feedback` does not loop back — the plan goes
 * straight to execution with nothing shown. The unreviewed count is the one
 * that matters, which is why this is one marker with a field rather than two.
 *
 * `log()`, matching `[zone-tier-grant-unusable]` (loopTelemetry.ts) — fires
 * unconditionally, no ZONE_VERBOSE_LOGS gate. This is diagnostic only: it does
 * not change what happens next, and it does not itself make the count
 * queryable — see the commit message for what that claim does and does not
 * cover.
 */
export function emitPlanEmptyApproval(data: {
  runId: string;
  reasonField: "noChangeReason" | "cannotVerifyReason" | "answerOnlyReason" | "unknown";
  reviewed: boolean;
}): void {
  log("[zone-plan-empty-approval]", JSON.stringify(data));
}

export type PlanDecision =
  | "accept_all"           // auto-approve all edits + commands for this run
  | "manual"               // approve commands normally; edits auto-apply
  | "refine"               // regenerate the plan without feedback
  | "feedback"             // give feedback, regenerate, re-show modal (stay in plan mode)
  | "approve_with_feedback" // give feedback, regenerate once, then execute
  | "reject"               // cancel the run
  | "timeout";             // approval wait exceeded timeout

type PendingPlan = {
  runId: string;
  proposal: PlanReadyProposal;
  resolve: (result: { decision: PlanDecision; feedback?: string }) => void;
  timeout: NodeJS.Timeout;
};

const pendingPlans = new Map<string, PendingPlan>();

export function requestPlanApproval(input: {
  proposal: PlanReadyProposal;
  emit: (evt: {
    type: "plan_ready_for_approval";
    runId: string;
    ts: number;
    title: string;
    planId: string;
    planObjective: string;
    planStepsJson: string;
    planScopeNotes?: string;
    planNoChangeReason?: string;
    planCannotVerifyReason?: string;
    planAnswerOnlyReason?: string;
    planRiskHints: string[];
    planScopeSummary: string;
  }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** When true, resolve immediately as "accept_all" without SSE emission or pending state. */
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
    // Whether input.emit (the thing that renders PlanReadyModal) actually fired. Read by
    // `finish` at call time, not capture time — a caller resolving before the flag flips
    // (the already-aborted branch below) correctly reports false; every other resolver runs
    // after it flips, since all of them are responses to a modal that was already shown.
    let modalEmitted = false;
    const finish = (result: { decision: PlanDecision; feedback?: string }) => {
      const entry = pendingPlans.get(planId);
      if (entry) {
        try { clearTimeout(entry.timeout); } catch {}
        pendingPlans.delete(planId);
      }
      resolve({ planId, decision: result.decision, feedback: result.feedback, modalEmitted });
    };

    const timeout = setTimeout(() => finish({ decision: "timeout" }), timeoutMs);
    pendingPlans.set(planId, { runId: proposal.runId, proposal, resolve: finish, timeout });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        finish({ decision: "reject" });
        return;
      }
      const onAbort = () => {
        try { input.abortSignal?.removeEventListener("abort", onAbort as () => void); } catch {}
        finish({ decision: "reject" });
      };
      try { input.abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }

    // Emit LAST — synchronous resolvers (e.g. TUI bus) find the registered entry.
    input.emit({
      type: "plan_ready_for_approval",
      runId: proposal.runId,
      ts: Date.now(),
      title: `Plan ready: ${proposal.objective.slice(0, 80)}`,
      planId,
      planObjective: proposal.objective,
      planStepsJson: JSON.stringify(proposal.steps),
      planRiskHints: proposal.riskHints,
      planScopeSummary: proposal.scopeSummary,
      ...(proposal.scopeNotes ? { planScopeNotes: proposal.scopeNotes } : {}),
      ...(proposal.noChangeReason ? { planNoChangeReason: proposal.noChangeReason } : {}),
      ...(proposal.cannotVerifyReason ? { planCannotVerifyReason: proposal.cannotVerifyReason } : {}),
      ...(proposal.answerOnlyReason ? { planAnswerOnlyReason: proposal.answerOnlyReason } : {}),
    });
    modalEmitted = true;
  });
}

export function resolvePlanApproval(input: {
  planId: string;
  runId: string;
  decision: PlanDecision;
  feedback?: string;
}): { ok: boolean; message?: string } {
  const planId = String(input.planId || "").trim();
  const runId = String(input.runId || "").trim();
  const entry = pendingPlans.get(planId);
  if (!entry) return { ok: false, message: "unknown_plan_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };
  entry.resolve({ decision: input.decision, feedback: input.feedback });
  return { ok: true };
}

export function rejectPendingPlansForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  for (const [planId, entry] of Array.from(pendingPlans.entries())) {
    if (entry.runId === runId) {
      n += 1;
      try { entry.resolve({ decision: "reject" }); } catch {}
      pendingPlans.delete(planId);
      try { clearTimeout(entry.timeout); } catch {}
    }
  }
  return n;
}
