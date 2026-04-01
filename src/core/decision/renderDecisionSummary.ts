import type {
  DecideExecutionModeResult,
  DecisionReason,
} from "./decideExecutionMode.js";
import type { SavedAgentResult, ValidationIssue } from "../../types/agent.js";
function formatReason(reason: DecisionReason): string {
  const detailSuffix =
    reason.details && reason.details.length > 0
      ? ` (${reason.details.join(" | ")})`
      : "";

  const severityLabel =
    reason.severity === "critical"
      ? "CRITICAL"
      : reason.severity === "warning"
        ? "WARNING"
        : "INFO";

  return `- [${severityLabel}] ${reason.code}: ${reason.message}${detailSuffix}`;
}

function buildRecommendation(result: DecideExecutionModeResult): string {
  switch (result.mode) {
    case "blocked":
      return "Do not apply automatically. Fix blocking validation issues first.";
    case "preview_only":
      return "Preview the patch and review warnings before any apply step.";
    case "safe_to_apply":
      return "Patch can be applied automatically under current safeguards.";
    default:
      return "Review the result before continuing.";
  }
}

export function renderDecisionSummary(
  result: DecideExecutionModeResult
): string {
  const lines: string[] = [];

  lines.push("=== EXECUTION DECISION ===");
  lines.push(`Mode: ${result.mode}`);
  lines.push(`Confidence Score: ${result.confidenceScore}`);
  lines.push("");

  lines.push("Reasons:");
  if (result.reasons.length === 0) {
    lines.push("- No explicit reasons recorded.");
  } else {
    for (const reason of result.reasons) {
      lines.push(formatReason(reason));
    }
  }

  lines.push("");
  lines.push("Recommendation:");
  lines.push(buildRecommendation(result));

  return lines.join("\n");
}

function formatIssueSeverity(severity: ValidationIssue["severity"]): string {
  if (severity === "error") return "ERROR";
  if (severity === "warning") return "WARNING";
  return "INFO";
}

function formatSavedRecommendation(result: SavedAgentResult): string {
  if (result.decision.recommendation) {
    return result.decision.recommendation;
  }

  switch (result.decision.mode) {
    case "blocked":
      return "Do not apply automatically. Fix blocking validation issues first.";
    case "preview":
      return "Preview the patch and review warnings before any apply step.";
    case "apply":
      return "Patch can be applied automatically under current safeguards.";
    default:
      return "Review the result before continuing.";
  }
}

export function renderSavedAgentResultSummary(
  result: SavedAgentResult
): string {
  const lines: string[] = [];

  lines.push("=== AGENT DECISION ===");
  lines.push(`Mode: ${result.decision.mode}`);

  const confidenceLevel = result.confidenceBreakdown?.level
    ? ` (${result.confidenceBreakdown.level})`
    : "";
  lines.push(`Confidence: ${result.decision.confidence}/100${confidenceLevel}`);

  lines.push("");
  lines.push("Recommendation:");
  lines.push(formatSavedRecommendation(result));

  if (result.issues?.topRisks?.length) {
    lines.push("");
    lines.push("Top Risks:");
    for (const risk of result.issues.topRisks.slice(0, 5)) {
      const meta =
        risk.category && risk.relatedCode
          ? ` (${risk.category} / ${risk.relatedCode})`
          : risk.category
            ? ` (${risk.category})`
            : risk.relatedCode
              ? ` (${risk.relatedCode})`
              : "";
      lines.push(
        `- [${formatRiskSeverity(risk.severity)} | score=${risk.score}] ${risk.title}${meta}`
      );
    }
  }

  if (result.issues?.grouped?.length) {
    lines.push("");
    lines.push("Issue Groups:");
    for (const group of result.issues.grouped) {
      lines.push(
        `- ${group.label}: ${group.errors} error, ${group.warnings} warning`
      );
    }
  }

  if (result.issues?.summary) {
    lines.push("");
    lines.push("Summary:");
    lines.push(
      `- Total: ${result.issues.summary.total} issue(s)`
    );
    lines.push(
      `- Errors: ${result.issues.summary.errors}`
    );
    lines.push(
      `- Warnings: ${result.issues.summary.warnings}`
    );
  }

  if (result.statusLine) {
    lines.push("");
    lines.push("Status:");
    lines.push(result.statusLine);
  }

  return lines.join("\n");
}
function formatRiskSeverity(severity: "high" | "medium" | "low"): string {
  if (severity === "high") return "HIGH";
  if (severity === "medium") return "MEDIUM";
  return "LOW";
}