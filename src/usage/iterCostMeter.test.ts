import { describe, expect, it } from "vitest";
import {
  buildIterCostUpdateFromRecords,
  cacheHitRatio,
} from "./iterCostMeter.js";
import type { UsageRecord } from "./usageTracker.js";

function rec(partial: Partial<UsageRecord>): UsageRecord {
  return {
    timestamp: "2026-05-09T00:00:00.000Z",
    userId: "user-1",
    runId: "run-1",
    provider: "openai",
    model: "gpt-5.4",
    input_uncached: 0,
    cache_write: 0,
    cache_read: 0,
    output: 0,
    est_cost_usd: 0,
    ...partial,
  };
}

describe("iter cost meter payload", () => {
  it("assembles per-iter and cumulative cost/cache metrics from usage records", () => {
    const update = buildIterCostUpdateFromRecords({
      runId: "run-1",
      iter: 2,
      totalIter: 15,
      records: [
        rec({ input_uncached: 1000, cache_read: 0, output: 100 }),
        rec({ input_uncached: 200, cache_read: 800, output: 100 }),
      ],
    });

    expect(update).not.toBeNull();
    expect(update!.payload).toMatchObject({
      type: "iter_cost_update",
      runId: "run-1",
      iter: 2,
      totalIter: 15,
      input_uncached: 200,
      cache_read: 800,
      total_input_uncached: 1200,
      total_cache_read: 800,
      total_output: 200,
      iter_count: 2,
    });
    expect(update!.payload.cacheHitThisIter).toBeCloseTo(0.8, 5);
    expect(update!.payload.cacheHitCumulative).toBeCloseTo(0.4, 5);
    expect(update!.payload.iterCost).toBeGreaterThan(0);
    expect(update!.payload.cumulativeCost).toBeGreaterThan(update!.payload.iterCost);
  });

  it("computes visual cache-hit scenarios", () => {
    expect(cacheHitRatio({ input_uncached: 100, cache_write: 0, cache_read: 0 })).toBe(0);
    expect(cacheHitRatio({ input_uncached: 50, cache_write: 0, cache_read: 50 })).toBe(0.5);
    expect(cacheHitRatio({ input_uncached: 11, cache_write: 0, cache_read: 89 })).toBe(0.89);
  });
});
