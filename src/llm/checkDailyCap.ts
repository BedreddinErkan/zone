import { resolveDailyUsdCap } from "./usdCapResolver.js";
import { getPatchUserFacingReason } from "./patchUserFacingReason.js";
import type { PatchTerminationOutcome } from "./patchUserFacingReason.js";
import { getUsage } from "../usage/usageTracker.js";
import { readDailyUsdCapOverride } from "../visual/tierSettings.js";
import { loadOrgPolicy } from "./policyLoader.js";
import { debugLog } from "../utils/logger.js";

export type DailyCapCheck =
  | { allowed: true }
  | { allowed: false; outcome: PatchTerminationOutcome; spentUsd: number; capUsd: number };

/**
 * Pure cap check: resolves cap from the four-source chain, reads today's usage,
 * and returns whether the request is allowed to proceed.
 *
 * Accepts explicit policy/user/env values so unit tests can control each source
 * without touching the environment.
 */
export async function checkDailyCap(input: {
  userId: string;
  policyValue?: number;
  userOverride?: number;
  envValue?: string;
  runId?: string;
}): Promise<DailyCapCheck> {
  const capResolution = resolveDailyUsdCap({
    userId: input.userId,
    policyValue: input.policyValue,
    userOverride: input.userOverride,
    envValue: input.envValue,
  });

  if (capResolution.capUsd === 0) return { allowed: true };

  const todayUsage = await getUsage(input.userId, "day");

  debugLog("[zone-daily-usd-status]", JSON.stringify({
    runId: input.runId ?? null,
    userId: input.userId,
    capUsd: capResolution.capUsd,
    capSource: capResolution.source,
    spentUsd: todayUsage.totalCostUsd,
    gate: "route",
  }));

  if (todayUsage.totalCostUsd < capResolution.capUsd) return { allowed: true };

  const outcome = getPatchUserFacingReason({
    terminationReason: "daily_usd_cap_exceeded",
    context: { costUsd: todayUsage.totalCostUsd, capUsd: capResolution.capUsd },
  });
  return { allowed: false, outcome, spentUsd: todayUsage.totalCostUsd, capUsd: capResolution.capUsd };
}

/**
 * Route-level cap gate: reads org policy, user override, and ZONE_DAILY_USD_CAP
 * from the environment, then delegates to checkDailyCap.
 *
 * Call this at the start of every LLM-dispatching route (after auth, before
 * decisionMode routing).
 */
export async function routeCapGate(userId: string, runId?: string): Promise<DailyCapCheck> {
  const policyResult = loadOrgPolicy(process.env.ZONE_ORG_POLICY_PATH);
  const policy = policyResult.ok ? policyResult.policy : null;
  return checkDailyCap({
    userId,
    policyValue: policy?.dailyUsdCap,
    userOverride: readDailyUsdCapOverride(),
    envValue: process.env.ZONE_DAILY_USD_CAP,
    runId,
  });
}
