import type { TaskTier, TaskClassification } from "./taskClassifier.js";
import type { ExecutionPlan } from "./executionPlan.js";
import { log } from "../utils/logger.js";

export type AuditMode = "auto" | "always" | "on_demand";

export const DEFAULT_AUDIT_MODE: AuditMode = "auto";

/** Regex for rename/move verbs in task text or plan objectives. */
const RENAME_VERB_RE = /\brename\b|\bmove\b/i;

/**
 * Returns true when the plan+classification profile is low-risk enough that
 * running the scope audit would be pure overhead with no scope risk to catch.
 *
 * All of the following must hold:
 *   1. The plan touches ≤ 2 distinct files (union of steps[*].filesLikely)
 *   2. The classified tier is not "complex"
 *   3. No step is flagged subagentEligible (i.e. no fanout)
 *   4. No rename/move verb appears in the plan's objective or scopeSummary
 */
export function isLowRiskPlan(
  plan: ExecutionPlan | null | undefined,
  classification: TaskClassification | null | undefined
): boolean {
  if (!plan || !classification) return false;

  // Condition 1: ≤ 3 distinct files across all plan steps (all referenced,
  // including read-only). Threshold is intentionally permissive — false
  // negatives (running audit on a 4-file mostly-read task) are acceptable
  // because the audit subagent is Haiku-downgraded to ~$0.04.
  // Option A chosen over adding an intent field to PlanStep (deferred to Lever 2).
  const allFiles = new Set(plan.steps.flatMap((s) => s.filesLikely ?? []));
  if (allFiles.size > 3) return false;

  // Condition 2: tier is not complex.
  if (classification.tier === "complex") return false;

  // Condition 3: no subagentEligible step (no fanout).
  if (plan.steps.some((s) => s.subagentEligible === true)) return false;

  // Condition 4: no rename/move verb in plan objective or scopeSummary.
  const planText = `${plan.objective} ${plan.scopeSummary}`;
  if (RENAME_VERB_RE.test(planText)) return false;

  return true;
}

export interface ShouldRunAuditParams {
  tier: TaskTier;
  auditMode: AuditMode;
  /** Future: API param override — when true, forces audit regardless of mode/tier. */
  explicitRequest?: boolean;
  /**
   * Phase O cost-opt: when provided together with classification, enables the
   * low-risk-plan skip path. When isLowRiskPlan(plan, classification) is true
   * and auditMode=auto (not forced), audit is skipped and a telemetry line is
   * emitted. explicitRequest=true bypasses this gate entirely.
   */
  plan?: ExecutionPlan | null;
  classification?: TaskClassification | null;
  /** Run ID forwarded to the telemetry log line. */
  runId?: string;
}

export interface ShouldRunAuditResult {
  shouldRun: boolean;
  reason: string;
}

export function shouldRunAudit(params: ShouldRunAuditParams): ShouldRunAuditResult {
  const { tier, auditMode, explicitRequest, plan, classification, runId } = params;

  if (explicitRequest) {
    return { shouldRun: true, reason: "explicit user request" };
  }

  switch (auditMode) {
    case "always":
      return { shouldRun: true, reason: "auditMode=always" };
    case "on_demand":
      return { shouldRun: false, reason: "auditMode=on_demand, no explicit request" };
    case "auto":
      if (tier === "simple") {
        return { shouldRun: false, reason: "auditMode=auto + tier=simple" };
      }
      // Phase O cost-opt: skip audit for low-risk plans.
      if (isLowRiskPlan(plan, classification)) {
        const allFiles = new Set(plan!.steps.flatMap((s) => s.filesLikely ?? []));
        log("[zone-audit-skipped]", JSON.stringify({
          reason: "low_risk_plan",
          runId: runId ?? null,
          tier,
          fileCount: allFiles.size,
          files: [...allFiles],
          classificationTier: classification!.tier,
          subagentEligible: plan!.steps.some((s) => s.subagentEligible === true),
          ts: new Date().toISOString(),
        }));
        return { shouldRun: false, reason: "low_risk_plan" };
      }
      return { shouldRun: true, reason: `auditMode=auto + tier=${tier}` };
  }
}
