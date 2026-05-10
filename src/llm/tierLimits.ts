import type { TaskClassification, TaskTier } from "./taskClassifier.js";

export interface TierLimits {
  /** Whether the Task (subagent dispatch) tool is allowed. False for simple tier. */
  taskToolAllowed: boolean;
  /** Maximum subagent calls allowed per parent run. 0 when taskToolAllowed is false. */
  maxSubagentCalls: number;
  /** Per-run token budget cap in tokens. Replaces the global TOKEN_BUDGET_CAP. */
  tokenBudgetCap: number;
  /** Hard ceiling applied on top of plan-aware iter computation. */
  iterCap: number;
}

export const TIER_LIMITS: Record<TaskTier, TierLimits> = {
  simple: {
    taskToolAllowed: false,
    maxSubagentCalls: 0,
    tokenBudgetCap: 400_000,
    iterCap: 15,
  },
  medium: {
    taskToolAllowed: true,
    maxSubagentCalls: 1,
    tokenBudgetCap: 600_000,
    iterCap: 25,
  },
  complex: {
    taskToolAllowed: true,
    maxSubagentCalls: 2,
    tokenBudgetCap: 800_000,
    iterCap: 40,
  },
};

/**
 * Resolves tier limits from a classification result.
 * ZONE_FORCE_TIER env var overrides the classifier result (for testing).
 * Falls back to medium limits when classification is absent.
 */
export function resolveTierLimits(classification?: TaskClassification | null): TierLimits {
  const forceTier = process.env["ZONE_FORCE_TIER"] as TaskTier | undefined;
  if (forceTier && Object.prototype.hasOwnProperty.call(TIER_LIMITS, forceTier)) {
    return TIER_LIMITS[forceTier];
  }
  if (!classification) {
    return TIER_LIMITS.medium;
  }
  return TIER_LIMITS[classification.tier];
}
