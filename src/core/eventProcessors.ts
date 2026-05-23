/** Pure-data helpers extracted from sink.ts for use by the TUI store. */

export type TokenBudgetStatus = "critical" | "warning" | "ok";

export type StatusBadge = {
  icon: string;
  color: string;
  text: string;
};

export type FileChange = {
  filePath: string;
  addedLines: number;
  removedLines: number;
};

export type RunCost = {
  totalUsd: number;
  iterCount: number;
  cacheHitPct: number;
};

export function computeIterCost(iter: number, cumulativeCost: number): string {
  return `iter ${iter} · $${cumulativeCost.toFixed(4)}`;
}

export function buildLoopCompleteSummary(iterCount: number, cumulativeCost: number): string {
  const parts: string[] = [];
  if (iterCount > 0) parts.push(`${iterCount}it`);
  if (cumulativeCost > 0) parts.push(`$${cumulativeCost.toFixed(4)}`);
  const summary = parts.join(" / ");
  return summary ? `Done — ${summary}` : "Done";
}

export function buildRunSummary(cost: RunCost, filesChanged: FileChange[]): string {
  const lines: string[] = [
    `$${cost.totalUsd.toFixed(4)} · ${cost.iterCount} iter · ${Math.round(cost.cacheHitPct)}% cache hit`,
  ];
  for (const f of filesChanged) {
    lines.push(`  ${f.filePath}  +${f.addedLines} -${f.removedLines}`);
  }
  return lines.join("\n");
}

export function classifyTokenBudgetStatus(ratio: number): TokenBudgetStatus {
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.7) return "warning";
  return "ok";
}

export function statusBadge(type: string, detail: string): StatusBadge {
  switch (type) {
    case "success":
      return { icon: "✓", color: "green", text: detail };
    case "warning":
      return { icon: "⚠", color: "yellow", text: detail };
    case "error":
      return { icon: "✗", color: "red", text: detail };
    default:
      return { icon: "·", color: "dim", text: detail };
  }
}
