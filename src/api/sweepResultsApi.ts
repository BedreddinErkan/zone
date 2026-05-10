import fs from "node:fs";
import path from "node:path";

const RESULTS_PATH = path.resolve(__dirname, "../../data/sweep-results.csv");

interface SweepRow {
  timestamp: string;
  taskId: string;
  tierExpected: string;
  tierForced: string;
  tierPredicted: string;
  classificationConfidence: number;
  classifierModel: string;
  fallbackUsed: boolean;
  costUsd: number;
  durationMs: number;
  decisionMode: string;
  rolledBack: boolean;
  filesChanged: number;
  passedExpected: boolean;
  errorMessage: string;
}

export interface TierStats {
  tier: string;
  runs: number;
  passRate: number;
  avgCostUsd: number;
  p50CostUsd: number;
  p95CostUsd: number;
  avgDurationMs: number;
  rollbackRate: number;
  fallbackRate: number;
}

export interface TaskStats {
  taskId: string;
  tierExpected: string;
  runs: number;
  passRate: number;
  avgCostUsd: number;
  stddevCostUsd: number;
  avgDurationMs: number;
  stddevDurationMs: number;
  isOutlier: boolean;
  lastSeen: string;
}

export interface RecentRun {
  timestamp: string;
  taskId: string;
  tierExpected: string;
  tierPredicted: string;
  costUsd: number;
  durationMs: number;
  decisionMode: string;
  passedExpected: boolean;
  errorMessage: string;
}

export interface DashboardData {
  generatedAt: string;
  totalRuns: number;
  overallPassRate: number;
  tierStats: TierStats[];
  taskStats: TaskStats[];
  recentRuns: RecentRun[];
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let val = "";
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          val += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          val += line[i++];
        }
      }
      fields.push(val);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

function parseRows(): SweepRow[] {
  if (!fs.existsSync(RESULTS_PATH)) return [];
  const text = fs.readFileSync(RESULTS_PATH, "utf8");
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0]!.split(",");
  const rows: SweepRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!);
    const get = (col: string) => fields[headers.indexOf(col)] ?? "";
    rows.push({
      timestamp: get("timestamp"),
      taskId: get("taskId"),
      tierExpected: get("tierExpected"),
      tierForced: get("tierForced"),
      tierPredicted: get("tierPredicted"),
      classificationConfidence: parseFloat(get("classificationConfidence")) || 0,
      classifierModel: get("classifierModel"),
      fallbackUsed: get("fallbackUsed") === "true",
      costUsd: parseFloat(get("costUsd")) || 0,
      durationMs: parseFloat(get("durationMs")) || 0,
      decisionMode: get("decisionMode"),
      rolledBack: get("rolledBack") === "true",
      filesChanged: parseInt(get("filesChanged"), 10) || 0,
      passedExpected: get("passedExpected") === "true",
      errorMessage: get("errorMessage"),
    });
  }
  return rows;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function buildTierStats(rows: SweepRow[]): TierStats[] {
  const tiers = ["simple", "medium", "complex"];
  return tiers.map((tier) => {
    const subset = rows.filter((r) => r.tierExpected === tier);
    if (subset.length === 0) {
      return {
        tier,
        runs: 0,
        passRate: 0,
        avgCostUsd: 0,
        p50CostUsd: 0,
        p95CostUsd: 0,
        avgDurationMs: 0,
        rollbackRate: 0,
        fallbackRate: 0,
      };
    }
    const costs = subset.map((r) => r.costUsd).sort((a, b) => a - b);
    const passed = subset.filter((r) => r.passedExpected).length;
    const rolledBack = subset.filter((r) => r.rolledBack).length;
    const fallback = subset.filter((r) => r.fallbackUsed).length;
    const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
    const avgDur = subset.reduce((a, r) => a + r.durationMs, 0) / subset.length;
    return {
      tier,
      runs: subset.length,
      passRate: passed / subset.length,
      avgCostUsd: avgCost,
      p50CostUsd: percentile(costs, 50),
      p95CostUsd: percentile(costs, 95),
      avgDurationMs: avgDur,
      rollbackRate: rolledBack / subset.length,
      fallbackRate: fallback / subset.length,
    };
  });
}

function buildTaskStats(rows: SweepRow[]): TaskStats[] {
  const byTask = new Map<string, SweepRow[]>();
  for (const row of rows) {
    const key = row.taskId;
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key)!.push(row);
  }

  // compute global cost stddev for outlier threshold
  const allCosts = rows.map((r) => r.costUsd);
  const globalMean = allCosts.length > 0 ? allCosts.reduce((a, b) => a + b, 0) / allCosts.length : 0;
  const globalStd = stddev(allCosts);
  const outlierThreshold = globalMean + 2 * globalStd;

  const stats: TaskStats[] = [];
  for (const [taskId, subset] of byTask.entries()) {
    const costs = subset.map((r) => r.costUsd);
    const durations = subset.map((r) => r.durationMs);
    const passed = subset.filter((r) => r.passedExpected).length;
    const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
    const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;
    const lastSeen = subset
      .map((r) => r.timestamp)
      .sort()
      .at(-1) ?? "";
    stats.push({
      taskId,
      tierExpected: subset[0]!.tierExpected,
      runs: subset.length,
      passRate: passed / subset.length,
      avgCostUsd: avgCost,
      stddevCostUsd: stddev(costs),
      avgDurationMs: avgDur,
      stddevDurationMs: stddev(durations),
      isOutlier: avgCost > outlierThreshold,
      lastSeen,
    });
  }
  return stats.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export function buildDashboardData(): DashboardData {
  const rows = parseRows();
  const totalRuns = rows.length;
  const overallPassRate =
    totalRuns > 0 ? rows.filter((r) => r.passedExpected).length / totalRuns : 0;

  const recentRuns: RecentRun[] = rows
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 50)
    .map((r) => ({
      timestamp: r.timestamp,
      taskId: r.taskId,
      tierExpected: r.tierExpected,
      tierPredicted: r.tierPredicted,
      costUsd: r.costUsd,
      durationMs: r.durationMs,
      decisionMode: r.decisionMode,
      passedExpected: r.passedExpected,
      errorMessage: r.errorMessage,
    }));

  return {
    generatedAt: new Date().toISOString(),
    totalRuns,
    overallPassRate,
    tierStats: buildTierStats(rows),
    taskStats: buildTaskStats(rows),
    recentRuns,
  };
}
