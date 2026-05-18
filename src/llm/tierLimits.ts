import type { TaskClassification, TaskTier } from "./taskClassifier.js";
import { readTierSettings } from "../visual/tierSettings.js";

export interface TierLimits {
  /** Whether the Task (subagent dispatch) tool is allowed. False for simple tier. */
  taskToolAllowed: boolean;
  /** Maximum subagent calls allowed per parent run. 0 when taskToolAllowed is false. */
  maxSubagentCalls: number;
  /** Per-run token budget cap in tokens. Replaces the global TOKEN_BUDGET_CAP. */
  tokenBudgetCap: number;
  /** Hard ceiling applied on top of plan-aware iter computation. */
  iterCap: number;
  /**
   * Phase D-S1: iteration cap for Phase 1 (investigation) of a phase-split run.
   * 0 means simple tier — Phase 1 is skipped, single-phase legacy path used.
   * Not user-overridable (system-level guarantee).
   */
  phase1Cap: number;
  /**
   * Phase D-S1: iteration cap for Phase 2 (execution) of a phase-split run.
   * Applied as Math.min(iterCap, phase2Cap) by agentLoop when phase2IterCapOverride is set.
   * Not user-overridable (system-level guarantee).
   */
  phase2Cap: number;
}

export const TIER_LIMITS: Record<TaskTier, TierLimits> = {
  simple: {
    taskToolAllowed: false,
    maxSubagentCalls: 0,
    tokenBudgetCap: 400_000,
    iterCap: 15,
    phase1Cap: 0,
    phase2Cap: 15,
  },
  medium: {
    taskToolAllowed: true,
    maxSubagentCalls: 1,
    tokenBudgetCap: 600_000,
    iterCap: 25,
    phase1Cap: 6,
    phase2Cap: 20,
  },
  complex: {
    taskToolAllowed: true,
    maxSubagentCalls: 4,
    tokenBudgetCap: 800_000,
    iterCap: 40,
    phase1Cap: 8,
    phase2Cap: 30,
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
 *
 * taskToolAllowed is NEVER user-overridable — it is a system-level guarantee.
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
    taskToolAllowed: base.taskToolAllowed, // system-level — never overridden
    maxSubagentCalls: userOverride.maxSubagentCalls ?? base.maxSubagentCalls,
    tokenBudgetCap: userOverride.tokenBudgetCap ?? base.tokenBudgetCap,
    iterCap: userOverride.iterCap ?? base.iterCap,
    phase1Cap: base.phase1Cap, // system-level — never overridden
    phase2Cap: base.phase2Cap, // system-level — never overridden
  };
}
