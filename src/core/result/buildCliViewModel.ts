import type {
  CliOutputFormat,
  SavedAgentResult,
  SavedDecisionMode,
  ValidationIssue
} from "../../types/agent.js";

export interface CliIssueItem {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface CliIssueGroup {
  label: string;
  errors: number;
  warnings: number;
  issues: CliIssueItem[];
}

export interface CliRiskItem {
  title: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  score: number;
  description: string;
  category: string;
}

export interface CliViewModel {
  decisionMode: SavedDecisionMode;
  decisionLabel: string;
  statusLine: string;
  confidenceScore: number;
  errorCount: number;
  warningCount: number;
  notes: string[];
  topRisks: CliRiskItem[];
  groupedIssues: CliIssueGroup[];
  rawResult: SavedAgentResult;
}

function toDecisionLabel(mode: SavedDecisionMode): string {
  switch (mode) {
    case "blocked":
      return "BLOCKED";
    case "preview":
      return "PREVIEW ONLY";
    case "apply":
      return "SAFE TO APPLY";
  }
}

function normalizeIssue(issue: ValidationIssue): CliIssueItem | null {
  if (issue.severity === "error") {
    return {
      code: issue.code,
      severity: "error",
      message: issue.message
    };
  }

  if (issue.severity === "warning" || issue.severity === "info") {
    return {
      code: issue.code,
      severity: "warning",
      message: issue.message
    };
  }

  return null;
}
function toCliRiskSeverity(
  severity: "high" | "medium" | "low"
): "HIGH" | "MEDIUM" | "LOW" {
  switch (severity) {
    case "high":
      return "HIGH";
    case "medium":
      return "MEDIUM";
    case "low":
      return "LOW";
  }
}
export function buildCliViewModel(result: SavedAgentResult): CliViewModel {
  const groupedIssues: CliIssueGroup[] = (result.issues?.grouped ?? []).map((group) => {
    const issues = group.issues
      .map(normalizeIssue)
      .filter((item): item is CliIssueItem => item !== null);

    return {
      label: group.label,
      errors: group.errors,
      warnings: group.warnings,
      issues
    };
  });

  const notes = [
    ...result.notes.execution,
    ...result.notes.assumptions,
    ...result.notes.followUps
  ];

  return {
    decisionMode: result.decision.mode,
    decisionLabel: toDecisionLabel(result.decision.mode),
    statusLine:
      result.statusLine ??
      `STATUS: ${result.decision.mode.toUpperCase()} | confidence=${result.decision.confidence}`,
    confidenceScore: result.confidenceBreakdown?.finalScore ?? result.decision.confidence,
    errorCount: result.issues?.summary.errors ?? 0,
    warningCount: result.issues?.summary.warnings ?? 0,
    notes,
      topRisks: (result.issues?.topRisks ?? []).map((risk) => ({
      title: risk.title,
      severity: toCliRiskSeverity(risk.severity),
      score: risk.score,
      description: risk.description,
      category: risk.category
    })),
    groupedIssues,
    rawResult: result
  };
}