import type { MetricsResponse } from "./metricsAggregator.js";

function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(pairs: [string, string][]) {
  const inner = pairs.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
  return `{${inner}}`;
}

function block(
  name: string,
  help: string,
  lines: { lbl: [string, string][]; value: number }[],
): string {
  const parts = [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} gauge`,
    ...lines.map((l) => `${name}${labels(l.lbl)} ${l.value}`),
  ];
  return parts.join("\n");
}

export function aggregatorToPrometheus(metrics: MetricsResponse): string {
  const p = metrics.period;
  const blocks: string[] = [];

  blocks.push(
    block("zone_runs", "Total agent runs in the period.", [
      { lbl: [["period", p]], value: metrics.runs },
    ]),
  );

  blocks.push(
    block("zone_usd_dollars", "Total USD cost of agent runs in the period.", [
      { lbl: [["period", p]], value: metrics.usdTotal },
    ]),
  );

  const td = metrics.tierDistribution;
  blocks.push(
    block("zone_tier_distribution", "Number of runs by task tier.", [
      { lbl: [["tier", "simple"],  ["period", p]], value: td.simple },
      { lbl: [["tier", "medium"],  ["period", p]], value: td.medium },
      { lbl: [["tier", "complex"], ["period", p]], value: td.complex },
    ]),
  );

  const termLines = Object.entries(metrics.terminationDistribution).map(([reason, count]) => ({
    lbl: [["reason", reason], ["period", p]] as [string, string][],
    value: count,
  }));
  blocks.push(
    block("zone_termination_distribution", "Number of runs by termination reason.", termLines),
  );

  blocks.push(
    block("zone_cache_hit_ratio", "Fraction of tokens served from cache.", [
      { lbl: [["period", p]], value: metrics.cacheHitRatio },
    ]),
  );

  blocks.push(
    block("zone_latency_ms", "Agent run latency percentiles in milliseconds.", [
      { lbl: [["quantile", "0.5"],  ["period", p]], value: metrics.latencyMs.p50 },
      { lbl: [["quantile", "0.95"], ["period", p]], value: metrics.latencyMs.p95 },
    ]),
  );

  blocks.push(
    block(
      "zone_graceful_degrade_rate",
      "Fraction of runs that did not complete naturally.",
      [{ lbl: [["period", p]], value: metrics.gracefulDegradeRate }],
    ),
  );

  blocks.push(
    block("zone_resumable_rate", "Fraction of degraded runs that are resumable.", [
      { lbl: [["period", p]], value: metrics.resumableRate },
    ]),
  );

  return blocks.join("\n\n") + "\n";
}
