import type { DecideExecutionModeResult } from "./decideExecutionMode.js";

function hasReasonCode(
  result: DecideExecutionModeResult,
  codes: string[]
): boolean {
  return result.reasons.some((reason) => codes.includes(reason.code));
}

function hasHighTopRisk(result: DecideExecutionModeResult): boolean {
  return (result.topRisks ?? []).some((risk) => risk.severity === "high");
}

export function buildRecommendation(
  result: DecideExecutionModeResult
): string {
  if (result.mode === "blocked") {
    if (
      hasReasonCode(result, [
        "SCHEMA_VALIDATION_ERROR",
        "SCHEMA_VALIDATION_WARNING",
        "LOW_SCHEMA_CONFIDENCE"
      ])
    ) {
      return "Do not apply automatically. Resolve schema issues and verify schema alignment first.";
    }

    return "Do not apply automatically. Fix blocking validation issues first.";
  }

  if (result.mode === "preview_only") {
    if (hasHighTopRisk(result)) {
      return "Preview the patch and complete manual review before any apply step because high-severity risks are still present.";
    }

    if (
      hasReasonCode(result, [
        "SCHEMA_VALIDATION_ERROR",
        "SCHEMA_VALIDATION_WARNING",
        "LOW_SCHEMA_CONFIDENCE"
      ])
    ) {
      return "Preview the patch and verify schema alignment before any apply step.";
    }

    if (
      hasReasonCode(result, [
        "PATCH_VALIDATION_WARNING",
        "PATCH_RISK_WARNING",
        "MISSING_VALIDATED_FILES"
      ])
    ) {
      return "Preview the patch and review patch scope before any apply step.";
    }

    return "Preview the patch and review warnings before any apply step.";
  }

  return "Patch can be applied automatically under current safeguards.";
}