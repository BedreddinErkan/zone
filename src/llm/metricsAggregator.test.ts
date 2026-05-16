/**
 * Phase K.3 — Pure aggregation logic for the /api/metrics endpoint.
 * These tests cover the aggregateMetrics function only; route + auth + cache
 * are covered in server.metrics.test.ts.
 */

import { describe, expect, it } from "vitest";
import { aggregateMetrics, type RunRecord } from "./metricsAggregator.js";

const NOW = 1_700_000_000_000; // fixed epoch for deterministic period windows
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function makeRun(overrides: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    costUsd: 0.01,
    ts: NOW - 1_000, // 1 second ago — safely within all windows
    ...overrides,
  };
}

describe("aggregateMetrics — empty input", () => {
  it("returns all-zeros with empty distributions when runs is empty", () => {
    const result = aggregateMetrics({
      userId: "u1",
      period: "day",
      runs: [],
      now: NOW,
    });

    expect(result.runs).toBe(0);
    expect(result.usdTotal).toBe(0);
    expect(result.tierDistribution).toEqual({ simple: 0, medium: 0, complex: 0 });
    expect(result.terminationDistribution).toEqual({});
    expect(result.cacheHitRatio).toBe(0);
    expect(result.latencyMs).toEqual({ p50: 0, p95: 0 });
    expect(result.period).toBe("day");
    expect(result.generatedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("aggregateMetrics — single run", () => {
  it("reflects a single run's values with p50 === p95 === that latency", () => {
    const result = aggregateMetrics({
      userId: "u1",
      period: "day",
      runs: [
        makeRun({
          runId: "r1",
          tier: "simple",
          terminationReason: "natural_completion",
          costUsd: 0.05,
          latencyMs: 3_200,
          cacheTokens: 400,
          totalTokens: 1_000,
          ts: NOW - 1_000,
        }),
      ],
      now: NOW,
    });

    expect(result.runs).toBe(1);
    expect(result.usdTotal).toBe(0.05);
    expect(result.tierDistribution).toEqual({ simple: 1, medium: 0, complex: 0 });
    expect(result.terminationDistribution).toEqual({ natural_completion: 1 });
    expect(result.cacheHitRatio).toBe(0.4); // 400/1000
    expect(result.latencyMs.p50).toBe(3_200);
    expect(result.latencyMs.p95).toBe(3_200);
  });
});

describe("aggregateMetrics — tier distribution", () => {
  it("counts each tier correctly across mixed runs", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "r1", tier: "simple" }),
      makeRun({ runId: "r2", tier: "simple" }),
      makeRun({ runId: "r3", tier: "medium" }),
      makeRun({ runId: "r4", tier: "complex" }),
      makeRun({ runId: "r5" }), // no tier — not counted
    ];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    expect(result.tierDistribution).toEqual({ simple: 2, medium: 1, complex: 1 });
    expect(result.runs).toBe(5);
  });

  it("builds terminationDistribution with correct counts", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "r1", terminationReason: "natural_completion" }),
      makeRun({ runId: "r2", terminationReason: "natural_completion" }),
      makeRun({ runId: "r3", terminationReason: "max_iterations" }),
      makeRun({ runId: "r4", terminationReason: "daily_usd_cap_exceeded" }),
      makeRun({ runId: "r5" }), // no reason — not counted
    ];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    expect(result.terminationDistribution).toEqual({
      natural_completion: 2,
      max_iterations: 1,
      daily_usd_cap_exceeded: 1,
    });
  });
});

describe("aggregateMetrics — period filtering", () => {
  it("excludes runs outside the day window", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "in-day", ts: NOW - DAY_MS + 1 }), // just inside
      makeRun({ runId: "out-day", ts: NOW - DAY_MS - 1 }), // just outside
    ];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    expect(result.runs).toBe(1);
  });

  it("excludes runs outside the week window but includes ones within", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "in-week", ts: NOW - WEEK_MS + 1_000 }),
      makeRun({ runId: "out-week", ts: NOW - WEEK_MS - 1_000 }),
    ];

    const dayResult = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });
    const weekResult = aggregateMetrics({ userId: "u1", period: "week", runs, now: NOW });
    const monthResult = aggregateMetrics({ userId: "u1", period: "month", runs, now: NOW });

    expect(dayResult.runs).toBe(0); // neither run is within 24h
    expect(weekResult.runs).toBe(1); // only the in-week run
    expect(monthResult.runs).toBe(2); // out-week (7d ago) is still inside 30d month window
  });

  it("month window: 30d (not calendar month)", () => {
    const MONTH_MS = 30 * DAY_MS;
    const runs: RunRecord[] = [
      makeRun({ runId: "in-month", ts: NOW - MONTH_MS + 1_000 }),
      makeRun({ runId: "out-month", ts: NOW - MONTH_MS - 1_000 }),
    ];

    const result = aggregateMetrics({ userId: "u1", period: "month", runs, now: NOW });

    expect(result.runs).toBe(1);
  });
});

describe("aggregateMetrics — cache ratio", () => {
  it("uses weighted token average when cacheTokens + totalTokens are present", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "r1", cacheTokens: 100, totalTokens: 200 }), // 50%
      makeRun({ runId: "r2", cacheTokens: 300, totalTokens: 600 }), // 50%
    ];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    // weighted: (100+300)/(200+600) = 400/800 = 0.5
    expect(result.cacheHitRatio).toBe(0.5);
  });

  it("falls back to simple average of cacheHitRatio when token counts absent", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "r1", cacheHitRatio: 0.2 }),
      makeRun({ runId: "r2", cacheHitRatio: 0.8 }),
    ];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    // simple average: (0.2 + 0.8) / 2 = 0.5
    expect(result.cacheHitRatio).toBe(0.5);
  });

  it("weighted takes priority over simple-average fallback when mixed", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "r1", cacheTokens: 600, totalTokens: 1_000 }), // 60%
      makeRun({ runId: "r2", cacheHitRatio: 0.1 }), // would pull average down if used
    ];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    // r1 has token data → hasWeightedData=true → weighted: 600/1000 = 0.6
    // r2's cacheHitRatio field is ignored once weighted path activates
    expect(result.cacheHitRatio).toBe(0.6);
  });

  it("returns 0 when no cache data at all", () => {
    const result = aggregateMetrics({
      userId: "u1",
      period: "day",
      runs: [makeRun({ runId: "r1" })],
      now: NOW,
    });

    expect(result.cacheHitRatio).toBe(0);
  });
});

describe("aggregateMetrics — latency percentiles", () => {
  it("computes p50 and p95 correctly for 10 known values", () => {
    // Values sorted: 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000 (10 items)
    // p50 index = floor(0.5 * 9) = 4 → 500
    // p95 index = floor(0.95 * 9) = floor(8.55) = 8 → 900
    const latencies = [600, 100, 900, 300, 500, 800, 200, 1000, 400, 700];
    const runs: RunRecord[] = latencies.map((l, i) =>
      makeRun({ runId: `r${i}`, latencyMs: l })
    );

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    expect(result.latencyMs.p50).toBe(500);
    expect(result.latencyMs.p95).toBe(900);
  });

  it("handles runs with no latencyMs — p50/p95 default to 0", () => {
    const runs: RunRecord[] = [makeRun({ runId: "r1" }), makeRun({ runId: "r2" })];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    expect(result.latencyMs).toEqual({ p50: 0, p95: 0 });
  });

  it("skips undefined latencyMs entries — only counts runs that have it", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "r1", latencyMs: 200 }),
      makeRun({ runId: "r2" }), // no latency
      makeRun({ runId: "r3", latencyMs: 400 }),
    ];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    // sorted: [200, 400], p50 = floor(0.5*1)=0 → 200, p95 = floor(0.95*1)=0 → 200
    expect(result.latencyMs.p50).toBe(200);
    expect(result.latencyMs.p95).toBe(200);
  });
});

describe("K.3.C3 — terminationReason + latencyMs propagated from run-summary records", () => {
  it("terminationDistribution populated when terminationReason present on runs", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "r1", terminationReason: "natural_completion", latencyMs: 2_000 }),
      makeRun({ runId: "r2", terminationReason: "natural_completion", latencyMs: 3_500 }),
      makeRun({ runId: "r3", terminationReason: "max_iterations", latencyMs: 8_000 }),
      makeRun({ runId: "r4" }), // old record without summary — excluded from distribution
    ];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    expect(result.terminationDistribution).toEqual({
      natural_completion: 2,
      max_iterations: 1,
    });
    expect(result.runs).toBe(4); // all 4 counted regardless
  });

  it("p50 and p95 are non-zero when latencyMs present, old records without it are excluded from stats", () => {
    const runs: RunRecord[] = [
      makeRun({ runId: "r1", terminationReason: "natural_completion", latencyMs: 1_200 }),
      makeRun({ runId: "r2", terminationReason: "daily_usd_cap_exceeded", latencyMs: 50 }),
      makeRun({ runId: "r3" }), // no latency — excluded from percentile calc
    ];

    const result = aggregateMetrics({ userId: "u1", period: "day", runs, now: NOW });

    // sorted latencies: [50, 1200]; p50 idx = floor(0.5*1)=0 → 50; p95 idx = 0 → 50
    expect(result.latencyMs.p50).toBe(50);
    expect(result.latencyMs.p95).toBe(50);
    expect(result.terminationDistribution).toEqual({
      natural_completion: 1,
      daily_usd_cap_exceeded: 1,
    });
  });
});
