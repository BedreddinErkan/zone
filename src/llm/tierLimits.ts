import type { TaskClassification, TaskTier } from "./taskClassifier.js";
import { readTierSettings } from "../visual/tierSettings.js";

export interface TierLimits {
  /** Maximum subagent calls allowed per parent run. */
  maxSubagentCalls: number;
  /** Per-run token budget cap in tokens. Replaces the global TOKEN_BUDGET_CAP. */
  tokenBudgetCap: number;
  /** Soft iteration warning threshold. Agent receives a wrap-up prompt at this iteration;
   *  the cost ceiling (tokenBudgetCap) is the actual hard stop. */
  softIterWarn: number;
}

export const TIER_LIMITS: Record<TaskTier, TierLimits> = {
  simple: {
    maxSubagentCalls: 0,
    tokenBudgetCap: 400_000,
    softIterWarn: 15,
  },
  medium: {
    maxSubagentCalls: 0,
    tokenBudgetCap: 600_000,
    softIterWarn: 25,
  },
  complex: {
    maxSubagentCalls: 4,
    tokenBudgetCap: 800_000,
    softIterWarn: 40,
  },
};

export interface ResolveTierOptions {
  /** Per-request tier override — takes priority over ZONE_FORCE_TIER env var. */
  forceTierOverride?: TaskTier;
}

/**
 * Resolves tier limits from a classification result.
 *
 * Priority (highest first):
 *   1. options.forceTierOverride — per-request override (sweep, API caller)
 *   2. ZONE_FORCE_TIER env var — server-level testing bypass (no user overrides)
 *   3. User overrides from ~/.zone/tier-limits.json — merged on top of TIER_LIMITS defaults
 *   4. TIER_LIMITS defaults — used when no classification or no user override
 */
export function resolveTierLimits(
  classification?: TaskClassification | null,
  options: ResolveTierOptions = {}
): TierLimits {
  if (
    options.forceTierOverride &&
    Object.prototype.hasOwnProperty.call(TIER_LIMITS, options.forceTierOverride)
  ) {
    return TIER_LIMITS[options.forceTierOverride];
  }

  const forceTier = process.env["ZONE_FORCE_TIER"] as TaskTier | undefined;
  if (forceTier && Object.prototype.hasOwnProperty.call(TIER_LIMITS, forceTier)) {
    return TIER_LIMITS[forceTier];
  }

  const tier: TaskTier = classification?.tier ?? "medium";
  const base = TIER_LIMITS[tier];

  const userSettings = readTierSettings();
  const userOverride = userSettings[tier];

  if (!userOverride) return base;

  return {
    maxSubagentCalls: userOverride.maxSubagentCalls ?? base.maxSubagentCalls,
    tokenBudgetCap: userOverride.tokenBudgetCap ?? base.tokenBudgetCap,
    softIterWarn: userOverride.softIterWarn ?? base.softIterWarn,
  };
}
