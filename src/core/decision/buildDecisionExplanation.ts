import type { ScoredRisk } from "../../types/agent.js";
import type { DecideExecutionModeResult } from "./decideExecutionMode.js";

function countReasonsBySeverity(
  reasons: DecideExecutionModeResult["reasons"]
): {
  critical: number;
  warning: number;
  info: number;
} {
  return reasons.reduce(
    (acc, reason) => {
      if (reason.severity === "critical") acc.critical += 1;
      else if (reason.severity === "warning") acc.warning += 1;
      else acc.info += 1;
      return acc;
    },
    { critical: 0, warning: 0, info: 0 }
  );
}

function countSeriousRisks(topRisks?: ScoredRisk[]): number {
  if (!topRisks || topRisks.length === 0) {
    return 0;
  }

  return topRisks.filter(
    (risk) => risk.severity === "high" || risk.severity === "medium"
  ).length;
}

function buildModeLead(result: DecideExecutionModeResult): string {
  switch (result.mode) {
    case "blocked":
      return "Decision was set to BLOCKED because blocking validation signals were detected.";
    case "preview_only":
      return "Decision was set to PREVIEW ONLY because manual review is still required.";
    case "safe_to_apply":
      return "Decision was set to SAFE TO APPLY because no blocking execution risks were detected.";
  }
}

function buildReasonSummary(result: DecideExecutionModeResult): string[] {
  const counts = countReasonsBySeverity(result.reasons);
  const lines: string[] = [];

  if (counts.critical > 0) {
    lines.push(`- ${counts.critical} critical reason(s) affected the decision`);
  }

  if (counts.warning > 0) {
    lines.push(`- ${counts.warning} warning-level reason(s) affected the decision`);
  }

  if (counts.info > 0 && result.mode === "safe_to_apply") {
    lines.push(`- ${counts.info} informational confirmation reason(s) were recorded`);
  }

  const seriousRiskCount = countSeriousRisks(result.topRisks);
  if (seriousRiskCount > 0) {
    lines.push(`- ${seriousRiskCount} medium/high top risk(s) remain visible in the result`);
  }

  return lines;
}

function buildClosingLine(result: DecideExecutionModeResult): string {
  switch (result.mode) {
    case "blocked":
      return "Automatic apply is not recommended until blocking issues are resolved.";
    case "preview_only":
      return "Automatic apply is not recommended until review is completed.";
    case "safe_to_apply":
      return "Automatic apply can proceed under the current safeguards.";
  }
}

export function buildDecisionExplanation(
  result: DecideExecutionModeResult
): string {
  const lines: string[] = [];

  lines.push(buildModeLead(result));

  const summaryLines = buildReasonSummary(result);
  if (summaryLines.length > 0) {
    lines.push("");
    lines.push(...summaryLines);
  }

  lines.push("");
  lines.push(buildClosingLine(result));

  return lines.join("\n");
}