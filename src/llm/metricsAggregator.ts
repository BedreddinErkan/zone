import { canResumeFromTerminationReason } from "./patchUserFacingReason.js";
import { readRecords, type UsageRecord } from "../usage/usageTracker.js";

// Tier values match the production TaskTier union ("simple" | "medium" | "complex").
// Note: policyLoader.ts uses "light" in allowedTiers for future Phase M enforcement;
// that's a separate schema concern — runtime classifier emits "simple", not "light".
export type RunTier = "simple" | "medium" | "complex";

export type RunRecord = {
  runId: string;
  /** Optional: not available from UsageRecord alone (requires run-level telemetry). */
  tier?: RunTier;
  /** Optional: not available from UsageRecord alone (requires run-level telemetry). */
  terminationReason?: string;
  costUsd: number;
  /** Simple-average fallback when cacheTokens/totalTokens are absent. */
  cacheHitRatio?: number;
  cacheTokens?: number;
  totalTokens?: number;
  /** Optional: not available from UsageRecord alone (requires run-level telemetry). */
  latencyMs?: number;
  /** Unix epoch ms — use earliest record timestamp for the run. */
  ts: number;
  /** Y.1.6.4: true when at least one LLM retry occurred during this run. */
  hasRetry?: boolean;
};

export type MetricsResponse = {
  period: "day" | "week" | "month" | "all";
  runs: number;
  usdTotal: number;
  tierDistribution: { simple: number; medium: number; complex: number };
  terminationDistribution: Record<string, number>;
  cacheHitRatio: number;
  latencyMs: { p50: number; p95: number };
  /** Fraction of runs in period that did NOT end with natural_completion (0–1). */
  gracefulDegradeRate: number;
  /** Fraction of degraded runs that were resumable via canResume (0–1). */
  resumableRate: number;
  /** Y.1.6.4 K.3: fraction of runs that triggered at least one LLM retry (0–1). */
  retryRate: number;
  generatedAt: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

function periodWindowMs(period: "day" | "week" | "month" | "all"): number {
  switch (period) {
    case "all":
      return Infinity;
    case "day":
      return DAY_MS;
    case "week":
      return WEEK_MS;
    case "month":
      return MONTH_MS;
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sortedAsc.length - 1));
  return sortedAsc[idx]!;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round3(n: number): number {
  return Math.round(n * 1_000) / 1_000;
}

export function aggregateMetrics(input: {
  userId: string;
  period: "day" | "week" | "month" | "all";
  runs: RunRecord[];
  now?: number;
}): MetricsResponse {
  const now = input.now ?? Date.now();
  const windowMs = periodWindowMs(input.period);

  const filtered = input.runs.filter((r) => now - r.ts <= windowMs);

  const tierDist: { simple: number; medium: number; complex: number } = {
    simple: 0,
    medium: 0,
    complex: 0,
  };
  const terminationDist: Record<string, number> = {};

  let totalCost = 0;
  let sumCacheTokens = 0;
  let sumTotalTokens = 0;
  let hasWeightedData = false;
  let sumCacheHitRatio = 0;
  let cacheRatioCount = 0;
  const latencies: number[] = [];

  for (const run of filtered) {
    totalCost += run.costUsd;

    if (run.tier) {
      tierDist[run.tier] += 1;
    }

    if (run.terminationReason) {
      terminationDist[run.terminationReason] =
        (terminationDist[run.terminationReason] ?? 0) + 1;
    }

    if (
      run.cacheTokens !== undefined &&
      run.totalTokens !== undefined &&
      run.totalTokens > 0
    ) {
      sumCacheTokens += run.cacheTokens;
      sumTotalTokens += run.totalTokens;
      hasWeightedData = true;
    } else if (run.cacheHitRatio !== undefined) {
      sumCacheHitRatio += run.cacheHitRatio;
      cacheRatioCount += 1;
    }

    if (run.latencyMs !== undefined) {
      latencies.push(run.latencyMs);
    }
  }

  let cacheHitRatio = 0;
  if (hasWeightedData && sumTotalTokens > 0) {
    cacheHitRatio = sumCacheTokens / sumTotalTokens;
  } else if (cacheRatioCount > 0) {
    cacheHitRatio = sumCacheHitRatio / cacheRatioCount;
  }

  latencies.sort((a, b) => a - b);

  const totalRuns = filtered.length;
  const naturalCount = terminationDist["natural_completion"] ?? 0;
  const degradedCount = totalRuns - naturalCount;
  const gracefulDegradeRate = totalRuns > 0 ? degradedCount / totalRuns : 0;

  const resumableCount = filtered.filter(
    (r) =>
      r.terminationReason &&
      r.terminationReason !== "natural_completion" &&
      canResumeFromTerminationReason(r.terminationReason)
  ).length;
  const resumableRate = degradedCount > 0 ? resumableCount / degradedCount : 0;

  const retryCount = filtered.filter((r) => r.hasRetry).length;
  const retryRate = totalRuns > 0 ? retryCount / totalRuns : 0;

  return {
    period: input.period,
    runs: totalRuns,
    usdTotal: round4(totalCost),
    tierDistribution: tierDist,
    terminationDistribution: terminationDist,
    cacheHitRatio: round3(cacheHitRatio),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    gracefulDegradeRate: round3(gracefulDegradeRate),
    resumableRate: round3(resumableRate),
    retryRate: round3(retryRate),
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Build per-run summaries from raw UsageRecord JSONL.
 * Groups by runId, summing cost + cache tokens so each run appears once.
 * latencyMs and terminationReason come from the K.3.C3 terminal run-summary
 * record (model: "__run_summary__") appended by agentLoop on completion.
 */
export function buildRunRecords(userId: string): RunRecord[] {
  const records = readRecords(userId);
  const runMap = new Map<string, {
    costUsd: number;
    /** Records in this run whose cost was unknown and are therefore absent from `costUsd`. */
    unknownCostRecords: number;
    cacheTokens: number;
    totalTokens: number;
    ts: number;
    latencyMs?: number;
    terminationReason?: string;
    hasRetry?: boolean;
  }>();

  for (const r of records) {
    const key = r.runId || `__anon_${r.timestamp}`;
    const ts = new Date(r.timestamp).getTime();

    // Y.1.6.4: retry sentinel — mark run as having retried, skip cost/token accumulation.
    if (r.model === "__run_retry__") {
      const existing = runMap.get(key);
      if (existing) {
        existing.hasRetry = true;
      } else {
        runMap.set(key, {
          costUsd: 0,
          unknownCostRecords: 0,
          cacheTokens: 0,
          totalTokens: 0,
          ts: Number.isNaN(ts) ? Date.now() : ts,
          hasRetry: true,
        });
      }
      continue;
    }

    const tokens =
      (r.input_uncached || 0) +
      (r.cache_write || 0) +
      (r.cache_read || 0) +
      (r.output || 0);
    const cacheTokens = r.cache_read || 0;
    // DECISION for this site (the metrics dashboard): an unknown cost is EXCLUDED from the run's
    // money total and COUNTED instead, the same rule getUsage applies. A dashboard that renders an
    // unpriceable run as `$0.0000` reads as "this run was free", which is the conflation the
    // nullable field exists to end; the count lets the row say "partially unpriced" instead.
    const knownCost = typeof r.est_cost_usd === "number" ? r.est_cost_usd : 0;
    const unknownCost = typeof r.est_cost_usd !== "number" ? 1 : 0;
    const existing = runMap.get(key);
    if (existing) {
      existing.costUsd += knownCost;
      existing.unknownCostRecords += unknownCost;
      existing.cacheTokens += cacheTokens;
      existing.totalTokens += tokens;
      if (!Number.isNaN(ts)) existing.ts = Math.min(existing.ts, ts);
      // Take from whichever record carries them (only the summary record will).
      if (r.latencyMs !== undefined) existing.latencyMs = r.latencyMs;
      if (r.terminationReason !== undefined) existing.terminationReason = r.terminationReason;
    } else {
      runMap.set(key, {
        costUsd: knownCost,
        unknownCostRecords: unknownCost,
        cacheTokens,
        totalTokens: tokens,
        ts: Number.isNaN(ts) ? Date.now() : ts,
        latencyMs: r.latencyMs,
        terminationReason: r.terminationReason,
      });
    }
  }

  return Array.from(runMap.entries()).map(([runId, data]) => ({
    runId,
    costUsd: data.costUsd,
    cacheTokens: data.cacheTokens,
    totalTokens: data.totalTokens,
    ts: data.ts,
    latencyMs: data.latencyMs,
    terminationReason: data.terminationReason,
    hasRetry: data.hasRetry,
  }));
}

// Re-export UsageRecord so callers that need both types can import from one place.
export type { UsageRecord };
