import { describe, expect, it } from "vitest";
import { aggregatorToPrometheus } from "./prometheusFormatter.js";
import type { MetricsResponse } from "./metricsAggregator.js";

function makeMetrics(overrides: Partial<MetricsResponse> = {}): MetricsResponse {
  return {
    period: "day",
    runs: 10,
    usdTotal: 0.1234,
    tierDistribution: { simple: 4, medium: 4, complex: 2 },
    terminationDistribution: { natural_completion: 8, max_iterations: 2 },
    cacheHitRatio: 0.345,
    latencyMs: { p50: 5000, p95: 12000 },
    gracefulDegradeRate: 0.2,
    resumableRate: 0.5,
    generatedAt: "2026-05-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("aggregatorToPrometheus", () => {
  it("ends with a newline", () => {
    const out = aggregatorToPrometheus(makeMetrics());
    expect(out.endsWith("\n")).toBe(true);
  });

  it("every metric block has HELP and TYPE headers", () => {
    const out = aggregatorToPrometheus(makeMetrics());
    const metricNames = [
      "zone_runs",
      "zone_usd_dollars",
      "zone_tier_distribution",
      "zone_termination_distribution",
      "zone_cache_hit_ratio",
      "zone_latency_ms",
      "zone_graceful_degrade_rate",
      "zone_resumable_rate",
    ];
    for (const name of metricNames) {
      expect(out).toContain(`# HELP ${name} `);
      expect(out).toContain(`# TYPE ${name} gauge`);
    }
  });

  it("emits correct zone_runs value", () => {
    const out = aggregatorToPrometheus(makeMetrics({ runs: 42, period: "week" }));
    expect(out).toContain(`zone_runs{period="week"} 42`);
  });

  it("emits correct zone_usd_dollars value", () => {
    const out = aggregatorToPrometheus(makeMetrics({ usdTotal: 1.2345, period: "month" }));
    expect(out).toContain(`zone_usd_dollars{period="month"} 1.2345`);
  });

  it("tier distribution: all 3 tiers always present, including zeros", () => {
    const out = aggregatorToPrometheus(
      makeMetrics({ tierDistribution: { simple: 5, medium: 0, complex: 0 } }),
    );
    expect(out).toContain(`zone_tier_distribution{tier="simple",period="day"} 5`);
    expect(out).toContain(`zone_tier_distribution{tier="medium",period="day"} 0`);
    expect(out).toContain(`zone_tier_distribution{tier="complex",period="day"} 0`);
  });

  it("termination distribution: one line per reason with correct labels", () => {
    const out = aggregatorToPrometheus(
      makeMetrics({
        terminationDistribution: {
          natural_completion: 7,
          max_iterations: 2,
          loop_detected: 1,
        },
      }),
    );
    expect(out).toContain(`zone_termination_distribution{reason="natural_completion",period="day"} 7`);
    expect(out).toContain(`zone_termination_distribution{reason="max_iterations",period="day"} 2`);
    expect(out).toContain(`zone_termination_distribution{reason="loop_detected",period="day"} 1`);
  });

  it("latency block emits p50 and p95 quantile lines", () => {
    const out = aggregatorToPrometheus(makeMetrics({ latencyMs: { p50: 3000, p95: 9500 } }));
    expect(out).toContain(`zone_latency_ms{quantile="0.5",period="day"} 3000`);
    expect(out).toContain(`zone_latency_ms{quantile="0.95",period="day"} 9500`);
  });

  it("label value escaping: backslash and double-quote escaped", () => {
    const out = aggregatorToPrometheus(
      makeMetrics({
        terminationDistribution: { 'reason_with_"quote"': 1, "path\\slash": 2 },
      }),
    );
    expect(out).toContain(`zone_termination_distribution{reason="reason_with_\\"quote\\"",period="day"} 1`);
    expect(out).toContain(`zone_termination_distribution{reason="path\\\\slash",period="day"} 2`);
  });

  it("empty metrics (runs=0, empty distributions) emits HELP+TYPE for all blocks", () => {
    const out = aggregatorToPrometheus(
      makeMetrics({
        runs: 0,
        usdTotal: 0,
        tierDistribution: { simple: 0, medium: 0, complex: 0 },
        terminationDistribution: {},
        cacheHitRatio: 0,
        latencyMs: { p50: 0, p95: 0 },
        gracefulDegradeRate: 0,
        resumableRate: 0,
      }),
    );
    expect(out).toContain("# HELP zone_runs ");
    expect(out).toContain("# HELP zone_termination_distribution ");
    expect(out).toContain(`zone_runs{period="day"} 0`);
    expect(out).toContain(`zone_tier_distribution{tier="simple",period="day"} 0`);
  });

  it("numeric values: integers without decimal point, ratios as-is", () => {
    const out = aggregatorToPrometheus(makeMetrics({ runs: 7, cacheHitRatio: 0.345 }));
    // integer runs: no decimal
    expect(out).toMatch(/zone_runs\{[^}]+\} 7\b/);
    // ratio: value as-is from MetricsResponse
    expect(out).toContain(`zone_cache_hit_ratio{period="day"} 0.345`);
  });

  it("gracefulDegradeRate and resumableRate present", () => {
    const out = aggregatorToPrometheus(
      makeMetrics({ gracefulDegradeRate: 0.667, resumableRate: 0.5 }),
    );
    expect(out).toContain(`zone_graceful_degrade_rate{period="day"} 0.667`);
    expect(out).toContain(`zone_resumable_rate{period="day"} 0.5`);
  });
});
