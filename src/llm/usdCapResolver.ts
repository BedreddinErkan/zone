export type DailyUsdCapResolution = {
  capUsd: number; // 0 = unlimited
  source: "policy" | "user_override" | "env" | "default";
};

const DEFAULT_DAILY_USD_CAP = 10.0;

/**
 * Resolve the daily USD cap with this precedence:
 *   1. policyValue (≥ 0, from org policy file) → source: "policy"  (0 = unlimited)
 *   2. userOverride (≥ 0) → source: "user_override"  (0 = unlimited)
 *   3. envValue parsed from ZONE_DAILY_USD_CAP (0 or -1 = unlimited) → source: "env"
 *   4. $10.00 default → source: "default"
 */
export function resolveDailyUsdCap(input: {
  userId: string;
  policyValue?: number;
  userOverride?: number;
  envValue?: string;
}): DailyUsdCapResolution {
  if (typeof input.policyValue === "number" && input.policyValue >= 0) {
    return { capUsd: input.policyValue, source: "policy" };
  }

  if (typeof input.userOverride === "number" && input.userOverride >= 0) {
    return { capUsd: input.userOverride, source: "user_override" };
  }

  if (typeof input.envValue === "string" && input.envValue.trim() !== "") {
    const parsed = parseFloat(input.envValue.trim());
    if (!Number.isNaN(parsed)) {
      const capUsd = parsed <= 0 ? 0 : parsed;
      return { capUsd, source: "env" };
    }
  }

  return { capUsd: DEFAULT_DAILY_USD_CAP, source: "default" };
}
