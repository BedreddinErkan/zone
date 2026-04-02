import { computeConfidenceBreakdown } from "../scoring/computeConfidenceBreakdown.js";
import type { ConfidenceFactor } from "../scoring/confidenceRules.js";
import type { PatchValidationIssue } from "../../types/patch.js";

export type DecisionMode = "blocked" | "preview_only" | "safe_to_apply";
import type { ScoredRisk } from "../../types/agent.js";
export type DecisionReasonCode =
  | "PATCH_VALIDATION_ERROR"
  | "PATCH_VALIDATION_WARNING"
  | "SCHEMA_VALIDATION_ERROR"
  | "SCHEMA_VALIDATION_WARNING"
  | "LOW_SCHEMA_CONFIDENCE"
  | "LOW_STORAGE_CONFIDENCE"
  | "MISSING_VALIDATED_FILES"
  | "PATCH_RISK_WARNING"
  | "ARCHITECTURE_WARNING"
  | "CRITICAL_CONFIDENCE_RISK"
  | "SAFE_TO_APPLY";

export interface DecisionReason {
  code: DecisionReasonCode;
  severity: "info" | "warning" | "critical";
  message: string;
  details?: string[];
}

export interface DecideExecutionModeInput {
  schemaConfidence: number;
  storageConfidence: number;
  architectureWarnings?: string[];
  patchRiskWarnings?: string[];
  patchValidationIssues?: PatchValidationIssue[];
  schemaValidationIssues?: PatchValidationIssue[];
  hasValidatedFiles: boolean;
}

export interface DecideExecutionModeResult {
  mode: DecisionMode;
  confidenceScore: number;
  reasons: DecisionReason[];
  topRisks?: ScoredRisk[];
}

function mapPatchIssueToDecisionReason(
  issue: PatchValidationIssue,
  mode: "error" | "warning"
): DecisionReason {
  return {
    code: mode === "error" ? "PATCH_VALIDATION_ERROR" : "PATCH_VALIDATION_WARNING",
    severity: mode === "error" ? "critical" : "warning",
    message: issue.message,
    details: [
      issue.code,
      ...(issue.filePath ? [issue.filePath] : []),
      ...(issue.details ?? []),
    ],
  };
}

function mapSchemaIssueToDecisionReason(
  issue: PatchValidationIssue,
  mode: "error" | "warning"
): DecisionReason {
  return {
    code: mode === "error" ? "SCHEMA_VALIDATION_ERROR" : "SCHEMA_VALIDATION_WARNING",
    severity: mode === "error" ? "critical" : "warning",
    message: issue.message,
    details: [
      issue.code,
      ...(issue.filePath ? [issue.filePath] : []),
      ...(issue.details ?? []),
    ],
  };
}

function mapConfidenceFactorToReason(factor: ConfidenceFactor): DecisionReason | null {
  switch (factor.key) {
    case "schema_confidence":
      return {
        code: "LOW_SCHEMA_CONFIDENCE",
        severity: factor.severity,
        message: factor.reason,
      };

    case "storage_confidence":
      return {
        code: "LOW_STORAGE_CONFIDENCE",
        severity: factor.severity,
        message: factor.reason,
      };

    case "missing_validated_files":
      return {
        code: "MISSING_VALIDATED_FILES",
        severity: factor.severity,
        message: factor.reason,
      };

    case "patch_risk_warnings":
      return {
        code: "PATCH_RISK_WARNING",
        severity: factor.severity,
        message: factor.label,
        details: [factor.reason],
      };

    case "architecture_warnings":
      return {
        code: "ARCHITECTURE_WARNING",
        severity: factor.severity,
        message: factor.label,
        details: [factor.reason],
      };

    case "validation_errors":
      return {
        code: "CRITICAL_CONFIDENCE_RISK",
        severity: "critical",
        message: factor.reason,
      };

    default:
      return null;
  }
}

export function decideExecutionMode(
  input: DecideExecutionModeInput
): DecideExecutionModeResult {
  const patchValidationIssues = input.patchValidationIssues ?? [];
  const schemaValidationIssues = input.schemaValidationIssues ?? [];

  const patchErrors = patchValidationIssues.filter((issue) => issue.level === "error");
  const patchWarnings = patchValidationIssues.filter((issue) => issue.level === "warning");

  const schemaErrors = schemaValidationIssues.filter((issue) => issue.level === "error");
  const schemaWarnings = schemaValidationIssues.filter((issue) => issue.level === "warning");

  const blockedReasons: DecisionReason[] = [
    ...patchErrors.map((issue) => mapPatchIssueToDecisionReason(issue, "error")),
    ...schemaErrors.map((issue) => mapSchemaIssueToDecisionReason(issue, "error")),
  ];

  if (blockedReasons.length > 0) {
    return {
      mode: "blocked",
      confidenceScore: 0,
      reasons: blockedReasons,
    };
  }

  const breakdown = computeConfidenceBreakdown({
    schemaConfidence: input.schemaConfidence,
    storageConfidence: input.storageConfidence,
    architectureWarnings: input.architectureWarnings ?? [],
    patchRiskWarnings: input.patchRiskWarnings ?? [],
    validationErrors: [],
    hasValidatedFiles: input.hasValidatedFiles,
  });

  const previewReasons: DecisionReason[] = [
    ...patchWarnings.map((issue) => mapPatchIssueToDecisionReason(issue, "warning")),
    ...schemaWarnings.map((issue) => mapSchemaIssueToDecisionReason(issue, "warning")),
    ...breakdown.factors
      .map(mapConfidenceFactorToReason)
      .filter((reason): reason is DecisionReason => reason !== null),
  ];

  if (previewReasons.length > 0) {
    return {
      mode: "preview_only",
      confidenceScore: breakdown.finalScore,
      reasons: previewReasons,
    };
  }

  return {
    mode: "safe_to_apply",
    confidenceScore: breakdown.finalScore,
    reasons: [
      {
        code: "SAFE_TO_APPLY",
        severity: "info",
        message: "No blocking or warning-level execution risks were detected.",
      },
    ],
  };
}