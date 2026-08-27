import { describe, expect, it } from "vitest";
import {
  buildIterCostUpdate,
  buildIterCostUpdateFromRecords,
  cacheHitRatio,
} from "./iterCostMeter.js";
import { OPENAI_PROFILE } from "../llm/providerProfile.js";
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

describe("buildIterCostUpdate — pricing through a provider profile (item 399)", () => {
  const GATEWAY = {
    id: "lab",
    protocol: "openai-chat" as const,
    adapterProvider: "openai" as const,
    keyRef: { envVar: "ZONE_GATEWAY_KEY_LAB", keyExample: "x" },
    pricing: { rates: { "openai/gpt-4o-mini": { input: 1, output: 2, cache_read: 0, cache_write: 0 } } },
  };
  const usage = { input_uncached: 1_000_000, cache_write: 0, cache_read: 0, output: 1_000_000, output_reasoning: 0 };
  const base = { runId: "r", iter: 0, totalIter: 5, model: "openai/gpt-4o-mini", current: usage };

  it("NEGATIVE CONTROL: with no profile, a gateway model id prices at 0 through the global table", () => {
    // This is the defect. If it ever stops holding, the assertion below proves nothing, because
    // the profile would no longer be what makes the difference.
    const { accumulator } = buildIterCostUpdate({ ...base, provider: "openai" });
    expect(accumulator.total_cost).toBe(0);
  });

  it("with the profile, the accumulator moves — which is what --max-budget-usd compares against", () => {
    const { accumulator } = buildIterCostUpdate({ ...base, provider: "openai", profile: GATEWAY });
    expect(accumulator.total_cost).toBeCloseTo(3, 10);
  });

  it("an unpriceable profile still yields 0, leaving the gate inert exactly as before", () => {
    const { pricing: _drop, ...unpriced } = GATEWAY;
    const { accumulator } = buildIterCostUpdate({ ...base, provider: "openai", profile: unpriced });
    expect(accumulator.total_cost).toBe(0);
  });

  it("a built-in profile prices identically to the no-profile path — no drift for vendors", () => {
    const withProfile = buildIterCostUpdate({
      ...base, model: "gpt-4o", provider: "openai", profile: OPENAI_PROFILE,
    });
    const without = buildIterCostUpdate({ ...base, model: "gpt-4o", provider: "openai" });
    expect(withProfile.accumulator.total_cost).toBe(without.accumulator.total_cost);
    expect(without.accumulator.total_cost).toBeGreaterThan(0);
  });
});
