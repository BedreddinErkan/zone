import type { SavedAgentResult } from "../../types/agent.js";

function hasSchemaSignals(result: SavedAgentResult): boolean {
  const schemaIssues = result.validation.schema ?? [];
  return schemaIssues.length > 0;
}

function hasPatchSignals(result: SavedAgentResult): boolean {
  const patchIssues = result.validation.patch ?? [];
  return patchIssues.length > 0;
}

function hasHighTopRisk(result: SavedAgentResult): boolean {
  return (result.issues?.topRisks ?? []).some((risk) => risk.severity === "high");
}

export function buildSavedRecommendation(result: SavedAgentResult): string {
  if (result.decision.recommendation) {
    return result.decision.recommendation;
  }

  if (result.decision.mode === "blocked") {
    if (hasSchemaSignals(result)) {
      return "Do not apply automatically. Resolve schema issues and verify schema alignment first.";
    }

    return "Do not apply automatically. Fix blocking validation issues first.";
  }

  if (result.decision.mode === "preview") {
    if (hasHighTopRisk(result)) {
      return "Preview the patch and complete manual review before any apply step because high-severity risks are still present.";
    }

    if (hasSchemaSignals(result)) {
      return "Preview the patch and verify schema alignment before any apply step.";
    }

    if (hasPatchSignals(result)) {
      return "Preview the patch and review patch scope before any apply step.";
    }

    return "Preview the patch and review warnings before any apply step.";
  }

  return "Patch can be applied automatically under current safeguards.";
}