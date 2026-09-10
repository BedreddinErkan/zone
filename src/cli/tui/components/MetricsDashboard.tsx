import React from "react";
import { Box, Text, useInput } from "ink";
import { useState, useEffect } from "react";
import { buildRunRecords, aggregateMetrics, type MetricsResponse } from "../../../llm/metricsAggregator.js";
import { role, spacing } from "../theme.js";

type Period = "day" | "week" | "month" | "all";
const PERIODS: Period[] = ["day", "week", "month", "all"];
const PERIOD_LABEL: Record<Period, string> = { day: "Day", week: "Week", month: "Month", all: "All" };

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function fmtMs(n: number): string {
  return n === 0 ? "—" : `${n}ms`;
}

const TERM_ABBREV: Record<string, string> = {
  natural_completion: "natural",
  max_iterations: "max_iter",
  token_budget_exceeded: "token_budget",
  loop_detected: "loop",
  daily_usd_cap_exceeded: "usd_cap",
  compaction_exhausted: "compaction",
  upstream_unavailable: "unavailable",
};
const BAR_MAX_WIDTH = 15;

/**
 * Phase 2c — content-only metrics dashboard. No border, no title, no footer hints — those
 * come from OverlayShell when OverlayLayer wraps this component. Reads the same run records
 * MetricsModal.tsx reads, drives the same period / auto-refresh toggles, but closes via
 * OVERLAY_POP so the stack — not a per-modal flag — owns the lifecycle.
 *
 * MetricsModal.tsx stays on disk for the same reason ModelModal.tsx and ApiKeysView.tsx
 * do: tests render it directly. Phase 2d will retire it.
 */
export function MetricsDashboard(): React.ReactElement {
  const [period, setPeriod] = useState<Period>("day");
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const cols = process.stdout.columns ?? 80;
  const wide = cols >= 80;
  const narrow = cols < 60;
  const innerWidth = Math.min(cols - 4, 72);
  const colWidth = Math.floor(innerWidth / 2) - 1;

  useEffect(() => {
    const runs = buildRunRecords("local-dev");
    setData(aggregateMetrics({ userId: "local-dev", period, runs }));
  }, [period]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      const runs = buildRunRecords("local-dev");
      setData(aggregateMetrics({ userId: "local-dev", period, runs }));
    }, 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, period]);

  useInput((input, key) => {
    // Esc handled by central handler (Phase 3b).
    if (key.leftArrow) {
      setPeriod(p => PERIODS[(PERIODS.indexOf(p) - 1 + PERIODS.length) % PERIODS.length]!);
    } else if (key.rightArrow) {
      setPeriod(p => PERIODS[(PERIODS.indexOf(p) + 1) % PERIODS.length]!);
    } else if (input === "r" || input === "R") {
      setAutoRefresh(v => !v);
    }
  });

  const periodRow = PERIODS.map(p =>
    p === period ? `[${PERIOD_LABEL[p]}]` : PERIOD_LABEL[p]
  ).join("  ");

  const kpis: [string, string][] = data ? [
    ["Runs",         String(data.runs)],
    ["USD Total",    fmtUsd(data.usdTotal)],
    ["Cache Hit",    fmtPct(data.cacheHitRatio)],
    ["Degrade Rate", fmtPct(data.gracefulDegradeRate)],
    ["Resumable",    fmtPct(data.resumableRate)],
    ["P50 Run Time", fmtMs(data.latencyMs.p50)],
    ["P95 Run Time", fmtMs(data.latencyMs.p95)],
  ] : [];

  const termEntries = data
    ? Object.entries(data.terminationDistribution).sort((a, b) => b[1] - a[1])
    : [];
  const maxCount = termEntries[0]?.[1] ?? 0;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>Period: <Text bold>{periodRow}</Text></Text>
        <Text>Auto-refresh: {autoRefresh
          ? <Text color={role.success}>on</Text>
          : <Text dimColor>off</Text>}
        </Text>
      </Box>

      <Box marginTop={spacing.sm}>
        {!data || data.runs === 0 ? (
          <Text dimColor>No runs yet — start a conversation and metrics will appear.</Text>
        ) : wide ? (
          <Box flexDirection="column">
            {([0, 2, 4] as const).map(i => (
              <Box key={i} flexDirection="row">
                <Box width={colWidth}>
                  <Text><Text dimColor>{kpis[i]![0]}: </Text>{kpis[i]![1]}</Text>
                </Box>
                {kpis[i + 1] && (
                  <Text><Text dimColor>{kpis[i + 1]![0]}: </Text>{kpis[i + 1]![1]}</Text>
                )}
              </Box>
            ))}
            <Box flexDirection="row">
              <Box width={colWidth} />
              <Text><Text dimColor>{kpis[6]![0]}: </Text>{kpis[6]![1]}</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {kpis.map(([lbl, val]) => (
              <Box key={lbl}><Text><Text dimColor>{lbl}: </Text>{val}</Text></Box>
            ))}
          </Box>
        )}
      </Box>

      {data && data.runs > 0 && !narrow && termEntries.length > 0 && (
        <Box flexDirection="column" marginTop={spacing.sm}>
          <Text bold>Termination Distribution:</Text>
          {termEntries.map(([label, count]) => {
            const lbl = wide ? label : (TERM_ABBREV[label] ?? label.slice(0, 12));
            const bar = "█".repeat(maxCount > 0 ? Math.round((count / maxCount) * BAR_MAX_WIDTH) : 0);
            const pct = Math.round((count / data.runs) * 100);
            return (
              <Box key={label} paddingLeft={spacing.sm}>
                <Text><Text dimColor>{lbl}:</Text> {bar} {pct}%</Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={spacing.sm}>
        <Text dimColor>←→ change period · R toggle refresh · Esc close</Text>
      </Box>
    </Box>
  );
}
