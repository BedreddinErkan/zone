import type { SavedAgentResult } from "../../types/agent.js";

function buildLead(result: SavedAgentResult): string {
  switch (result.decision.mode) {
    case "blocked":
      return "Decision was saved as BLOCKED because blocking signals were detected in the result.";
    case "preview":
      return "Decision was saved as PREVIEW ONLY because manual review is still required.";
    case "apply":
      return "Decision was saved as SAFE TO APPLY because no blocking execution signals were recorded.";
  }
}

function buildIssueLines(result: SavedAgentResult): string[] {
  const lines: string[] = [];

  const errorCount = result.issues?.summary?.errors ?? 0;
  const warningCount = result.issues?.summary?.warnings ?? 0;

  if (errorCount > 0) {
    lines.push(`- ${errorCount} error-level issue(s) remain in the saved result`);
  }

  if (warningCount > 0) {
    lines.push(`- ${warningCount} warning-level issue(s) remain in the saved result`);
  }

  const seriousRiskCount =
    result.issues?.topRisks?.filter(
      (risk) => risk.severity === "high" || risk.severity === "medium"
    ).length ?? 0;

  if (seriousRiskCount > 0) {
    lines.push(`- ${seriousRiskCount} medium/high top risk(s) remain visible in the saved result`);
  }

  return lines;
}

function buildClosing(result: SavedAgentResult): string {
  switch (result.decision.mode) {
    case "blocked":
      return "Automatic apply is not recommended until blocking issues are resolved.";
    case "preview":
      return "Automatic apply is not recommended until review is completed.";
    case "apply":
      return "Automatic apply can proceed under the current safeguards.";
  }
}

export function buildSavedDecisionExplanation(
  result: SavedAgentResult
): string {
  const lines: string[] = [];

  lines.push(buildLead(result));

  const issueLines = buildIssueLines(result);
  if (issueLines.length > 0) {
    lines.push("");
    lines.push(...issueLines);
  }

  lines.push("");
  lines.push(buildClosing(result));

  return lines.join("\n");
}