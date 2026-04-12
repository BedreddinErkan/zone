import type { DeveloperPatchScope } from "../core/runLlmPatchFlow.js";

export type TaskIntent = "micro_edit" | "standard" | "unknown";

export type IntentMismatchSeverity = "none" | "low" | "medium" | "high";

export type IntentMismatchReasonCode =
  | "LARGE_REWRITE"
  | "STRUCTURAL_LAYOUT_CHANGE"
  | "MASSIVE_STYLE_INJECTION"
  | "MULTI_FILE_EXPANSION"
  | "LARGE_CHANGED_LINE_COUNT";

export interface IntentMismatchDetectorInput {
  taskIntent: TaskIntent;
  patchScope: DeveloperPatchScope;
}

export interface IntentMismatchDetectorResult {
  hasMismatch: boolean;
  severity: IntentMismatchSeverity;
  reasonCodes: IntentMismatchReasonCode[];
  warnings: string[];
  confidenceCap?: number;
  forcePreviewOnly: boolean;
}

export function detectIntentMismatch(
  input: IntentMismatchDetectorInput
): IntentMismatchDetectorResult {
  if (input.taskIntent !== "micro_edit") {
    return {
      hasMismatch: false,
      severity: "none",
      reasonCodes: [],
      warnings: [],
      forcePreviewOnly: false,
    };
  }

  const reasonCodes: IntentMismatchReasonCode[] = [];
  const warnings: string[] = [];

  if (input.patchScope.rewriteLikeSuspicion) {
    reasonCodes.push("LARGE_REWRITE", "STRUCTURAL_LAYOUT_CHANGE");
  }
  if (input.patchScope.cssRewriteSuspicion) {
    reasonCodes.push("MASSIVE_STYLE_INJECTION");
  }
  if (input.patchScope.changedFileCount > 1) {
    reasonCodes.push("MULTI_FILE_EXPANSION");
  }
  if (input.patchScope.totalChangedLines > 15) {
    reasonCodes.push("LARGE_CHANGED_LINE_COUNT");
  }

  if (reasonCodes.length === 0) {
    return {
      hasMismatch: false,
      severity: "none",
      reasonCodes: [],
      warnings: [],
      forcePreviewOnly: false,
    };
  }

  warnings.push("Micro-edit task produced a larger-than-expected patch.");
  if (reasonCodes.includes("MASSIVE_STYLE_INJECTION")) {
    warnings.push("CSS patch scope is too large for a spacing-only request.");
  }

  let severity: IntentMismatchSeverity = "low";
  if (
    reasonCodes.includes("LARGE_REWRITE") ||
    reasonCodes.includes("STRUCTURAL_LAYOUT_CHANGE") ||
    reasonCodes.includes("MASSIVE_STYLE_INJECTION")
  ) {
    severity = "high";
  } else if (
    reasonCodes.includes("MULTI_FILE_EXPANSION") ||
    input.patchScope.totalChangedLines > 30
  ) {
    severity = "medium";
  }

  return {
    hasMismatch: true,
    severity,
    reasonCodes,
    warnings,
    confidenceCap: 55,
    forcePreviewOnly: severity === "high",
  };
}
