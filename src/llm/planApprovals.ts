/**
 * Plan-ready approval gate.
 * Emitted after plan generation when ZONE_PLAN_APPROVAL_CYCLE=1.
 * User chooses how to proceed before execution begins.
 */

import crypto from "node:crypto";

export interface PlanReadyProposal {
  runId: string;
  planId: string;
  objective: string;
  steps: Array<{ title: string; description: string; filesLikely: string[]; subagentEligible?: boolean }>;
}

export type PlanDecision =
  | "accept_all"   // auto-approve all edits + commands for this run
  | "manual"       // approve commands normally; edits auto-apply (Phase 2 will add per-edit gate)
  | "refine"       // regenerate the plan (Phase 3)
  | "feedback"     // give feedback and regenerate (Phase 3)
  | "reject"       // cancel the run
  | "timeout";     // approval wait exceeded timeout

type PendingPlan = {
  runId: string;
  proposal: PlanReadyProposal;
  resolve: (decision: PlanDecision) => void;
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
  }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** When true, resolve immediately as "accept_all" without SSE emission or pending state. */
  autoApprove?: boolean;
}): Promise<{ planId: string; decision: PlanDecision }> {
  const { proposal } = input;
  const planId = proposal.planId;

  if (input.autoApprove) {
    return Promise.resolve({ planId, decision: "accept_all" });
  }

  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0
      ? input.timeoutMs
      : 10 * 60 * 1000;

  return new Promise((resolve) => {
    const finish = (decision: PlanDecision) => {
      const entry = pendingPlans.get(planId);
      if (entry) {
        try { clearTimeout(entry.timeout); } catch {}
        pendingPlans.delete(planId);
      }
      resolve({ planId, decision });
    };

    const timeout = setTimeout(() => finish("timeout"), timeoutMs);
    pendingPlans.set(planId, { runId: proposal.runId, proposal, resolve: finish, timeout });

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

    // Emit LAST — synchronous resolvers (e.g. TUI bus) find the registered entry.
    input.emit({
      type: "plan_ready_for_approval",
      runId: proposal.runId,
      ts: Date.now(),
      title: `Plan ready: ${proposal.objective.slice(0, 80)}`,
      planId,
      planObjective: proposal.objective,
      planStepsJson: JSON.stringify(proposal.steps),
    });
  });
}

export function resolvePlanApproval(input: {
  planId: string;
  runId: string;
  decision: PlanDecision;
}): { ok: boolean; message?: string } {
  const planId = String(input.planId || "").trim();
  const runId = String(input.runId || "").trim();
  const entry = pendingPlans.get(planId);
  if (!entry) return { ok: false, message: "unknown_plan_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };
  entry.resolve(input.decision);
  return { ok: true };
}

export function rejectPendingPlansForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  for (const [planId, entry] of Array.from(pendingPlans.entries())) {
    if (entry.runId === runId) {
      n += 1;
      try { entry.resolve("reject"); } catch {}
      pendingPlans.delete(planId);
      try { clearTimeout(entry.timeout); } catch {}
    }
  }
  return n;
}
