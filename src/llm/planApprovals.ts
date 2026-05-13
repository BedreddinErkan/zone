import crypto from "node:crypto";
import type { ExecutionPlan } from "./executionPlan.js";

export type PlanApprovalAction = "approve" | "edit" | "reject" | "regenerate";

type PendingPlan = {
  runId: string;
  plan: ExecutionPlan;
  resolve: (result: PlanApprovalResult) => void;
  timeout: NodeJS.Timeout;
};

export type PlanApprovalResult =
  | { action: "approve"; plan: ExecutionPlan }
  | { action: "edit"; plan: ExecutionPlan }
  | { action: "reject" }
  | { action: "regenerate"; userFeedback: string };

const pendingPlans = new Map<string, PendingPlan>();

export function validateExecutionPlan(raw: unknown): ExecutionPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p["objective"] !== "string") return null;
  if (!Array.isArray(p["steps"]) || p["steps"].length === 0) return null;
  for (const step of p["steps"] as unknown[]) {
    if (!step || typeof step !== "object") return null;
    const s = step as Record<string, unknown>;
    if (typeof s["title"] !== "string" || typeof s["description"] !== "string") return null;
    if (!Array.isArray(s["filesLikely"])) return null;
  }
  if (!Array.isArray(p["riskHints"])) return null;
  if (typeof p["scopeSummary"] !== "string") return null;
  return {
    objective: p["objective"] as string,
    steps: (p["steps"] as Array<Record<string, unknown>>).map((s) => ({
      title: s["title"] as string,
      description: s["description"] as string,
      filesLikely: (s["filesLikely"] as unknown[]).filter((x): x is string => typeof x === "string"),
    })),
    riskHints: (p["riskHints"] as unknown[]).filter((x): x is string => typeof x === "string"),
    scopeSummary: p["scopeSummary"] as string,
  };
}

export function requestPlanApproval(input: {
  runId: string;
  plan: ExecutionPlan;
  regenAttempt?: number;
  maxRegens?: number;
  emit: (evt: {
    type: "plan_ready_for_review";
    runId: string;
    plan: ExecutionPlan;
    approvalId: string;
    regenAttempt: number;
    maxRegens: number;
  }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ approvalId: string; result: PlanApprovalResult }> {
  const runId = String(input.runId || "").trim();
  const approvalId = crypto.randomUUID();
  const timeoutMs =
    typeof input.timeoutMs === "number" && input.timeoutMs > 0
      ? input.timeoutMs
      : 10 * 60 * 1000;
  const regenAttempt = input.regenAttempt ?? 0;
  const maxRegens = input.maxRegens ?? 3;

  input.emit({ type: "plan_ready_for_review", runId, plan: input.plan, approvalId, regenAttempt, maxRegens });

  return new Promise((resolve) => {
    const finish = (result: PlanApprovalResult) => {
      const entry = pendingPlans.get(approvalId);
      if (entry) {
        try { clearTimeout(entry.timeout); } catch {}
        pendingPlans.delete(approvalId);
      }
      resolve({ approvalId, result });
    };

    const timeout = setTimeout(() => finish({ action: "reject" }), timeoutMs);
    pendingPlans.set(approvalId, { runId, plan: input.plan, resolve: finish, timeout });

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        finish({ action: "reject" });
        return;
      }
      const onAbort = () => {
        try { input.abortSignal?.removeEventListener("abort", onAbort as () => void); } catch {}
        finish({ action: "reject" });
      };
      try { input.abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }
  });
}

export function validateRegenerateFeedback(feedback: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof feedback !== "string") return { ok: false, reason: "userFeedback must be a string" };
  const trimmed = feedback.trim();
  if (trimmed.length === 0) return { ok: false, reason: "userFeedback cannot be empty" };
  if (trimmed.length > 500) return { ok: false, reason: "userFeedback exceeds 500 char limit" };
  return { ok: true };
}

export function resolvePlanApproval(input: {
  approvalId: string;
  action: PlanApprovalAction;
  runId: string;
  editedPlan?: unknown;
  userFeedback?: unknown;
}): { ok: boolean; message?: string } {
  const approvalId = String(input.approvalId || "").trim();
  const runId = String(input.runId || "").trim();
  const entry = pendingPlans.get(approvalId);
  if (!entry) return { ok: false, message: "unknown_approval_id" };
  if (runId && entry.runId && runId !== entry.runId) return { ok: false, message: "run_id_mismatch" };

  if (input.action === "reject") {
    entry.resolve({ action: "reject" });
    return { ok: true };
  }

  if (input.action === "edit") {
    const edited = validateExecutionPlan(input.editedPlan);
    if (!edited) return { ok: false, message: "invalid_edited_plan" };
    entry.resolve({ action: "edit", plan: edited });
    return { ok: true };
  }

  if (input.action === "regenerate") {
    const feedbackCheck = validateRegenerateFeedback(input.userFeedback);
    if (!feedbackCheck.ok) return { ok: false, message: feedbackCheck.reason };
    entry.resolve({ action: "regenerate", userFeedback: (input.userFeedback as string).trim() });
    return { ok: true };
  }

  // approve — use original plan
  entry.resolve({ action: "approve", plan: entry.plan });
  return { ok: true };
}

/**
 * Determine whether the plan approval gate should run for a given request.
 *
 * Priority:
 *  1. rawMode === "plan" (legacy alias) → always true, skipPlanReview ignored
 *  2. explicitPlanApprovalRequired (caller override) → use that value
 *  3. Auto-set: true for "patch" mode unless skipPlanReview
 *  4. All other modes (chat, investigate, auto) → false
 */
export function shouldRequirePlanApproval(opts: {
  rawMode: unknown;
  skipPlanReview?: boolean;
  explicitPlanApprovalRequired?: boolean;
}): { normalizedMode: unknown; planApprovalRequired: boolean } {
  const legacyPlanAlias = opts.rawMode === "plan";
  const normalizedMode = legacyPlanAlias ? "patch" : opts.rawMode;

  if (legacyPlanAlias) {
    return { normalizedMode, planApprovalRequired: true };
  }

  if (typeof opts.explicitPlanApprovalRequired === "boolean") {
    return { normalizedMode, planApprovalRequired: opts.explicitPlanApprovalRequired };
  }

  const planApprovalRequired = normalizedMode === "patch" && opts.skipPlanReview !== true;
  return { normalizedMode, planApprovalRequired };
}

export function rejectPendingPlansForRun(runIdRaw: string): number {
  const runId = String(runIdRaw || "").trim();
  if (!runId) return 0;
  let n = 0;
  for (const [approvalId, entry] of Array.from(pendingPlans.entries())) {
    if (entry.runId === runId) {
      n += 1;
      try { entry.resolve({ action: "reject" }); } catch {}
      pendingPlans.delete(approvalId);
      try { clearTimeout(entry.timeout); } catch {}
    }
  }
  return n;
}
