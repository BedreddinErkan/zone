import { Box, Text, useInput } from "ink";
import { useState, useEffect } from "react";
import { useStore } from "../store.js";
import { buildRunRecords, aggregateMetrics, type MetricsResponse } from "../../../llm/metricsAggregator.js";
import { role } from "../theme.js";

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

export function MetricsModal(): React.ReactElement {
  const { dispatch } = useStore();
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
    if (key.escape) {
      dispatch({ type: "METRICS_MODAL_CLOSE" });
    } else if (key.leftArrow) {
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={role.accent}
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color={role.accent}> Metrics</Text>
      <Text> </Text>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>Period: <Text bold>{periodRow}</Text></Text>
        <Text>Auto-refresh: {autoRefresh
          ? <Text color={role.success}>on</Text>
          : <Text dimColor>off</Text>}
        </Text>
      </Box>
      <Text> </Text>

      {!data || data.runs === 0 ? (
        <Text dimColor>No runs yet — start a conversation and metrics will appear.</Text>
      ) : wide ? (
        <>
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
        </>
      ) : (
        <>
          {kpis.map(([lbl, val]) => (
            <Text key={lbl}><Text dimColor>{lbl}: </Text>{val}</Text>
          ))}
        </>
      )}

      {data && data.runs > 0 && !narrow && termEntries.length > 0 && (
        <>
          <Text> </Text>
          <Text bold>Termination Distribution:</Text>
          {termEntries.map(([label, count]) => {
            const lbl = wide ? label : (TERM_ABBREV[label] ?? label.slice(0, 12));
            const bar = "█".repeat(maxCount > 0 ? Math.round((count / maxCount) * BAR_MAX_WIDTH) : 0);
            const pct = Math.round((count / data.runs) * 100);
            return (
              <Text key={label}>  <Text dimColor>{lbl}:</Text> {bar} {pct}%</Text>
            );
          })}
        </>
      )}

      <Text> </Text>
      <Text dimColor>←→ change period · R toggle refresh · Esc close</Text>
    </Box>
  );
}
