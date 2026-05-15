export type DailyUsdCapResolution = {
  capUsd: number; // 0 = unlimited
  source: "user_override" | "env" | "default";
};

const DEFAULT_DAILY_USD_CAP = 10.0;

/**
 * Resolve the daily USD cap with this precedence:
 *   1. userOverride (≥ 0) → source: "user_override"  (0 = unlimited)
 *   2. envValue parsed from ZONE_DAILY_USD_CAP (0 or -1 = unlimited) → source: "env"
 *   3. $10.00 default → source: "default"
 */
export function resolveDailyUsdCap(input: {
  userId: string;
  userOverride?: number;
  envValue?: string;
}): DailyUsdCapResolution {
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
