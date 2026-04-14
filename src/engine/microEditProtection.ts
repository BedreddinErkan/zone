import type { DeveloperPatchScope } from "../core/runLlmPatchFlow.js";
import type {
  IntentMismatchDetectorResult,
  TaskIntent,
} from "./intentMismatchDetector.js";
import type { PatchQualityScorerResult } from "./patchQualityScorer.js";

export interface MicroEditProtectionInput {
  taskIntent: TaskIntent;
  patchScope: DeveloperPatchScope;
  intentMismatch?: Pick<
    IntentMismatchDetectorResult,
    "hasMismatch" | "severity" | "reasonCodes"
  >;
  patchQuality?: Pick<PatchQualityScorerResult, "qualityScore">;
}

export interface MicroEditProtectionResult {
  isViolation: boolean;
  violationReasons: string[];
  shouldForcePreview: boolean;
  shouldDowngradeSafety: boolean;
}

const MICRO_EDIT_CHANGED_LINE_LIMIT = 40;

export function enforceMicroEditProtection(
  input: MicroEditProtectionInput
): MicroEditProtectionResult {
  if (input.taskIntent !== "micro_edit") {
    return {
      isViolation: false,
      violationReasons: [],
      shouldForcePreview: false,
      shouldDowngradeSafety: false,
    };
  }

  const violationReasons: string[] = [];
  const reasonCodes = new Set(input.intentMismatch?.reasonCodes ?? []);

  if (input.patchScope.changedFileCount > 1) {
    violationReasons.push("Micro-edit patch changed multiple files.");
  }
  if (input.patchScope.rewriteLikeSuspicion || reasonCodes.has("LARGE_REWRITE")) {
    violationReasons.push("Micro-edit patch expanded into a large rewrite.");
  }
  if (
    reasonCodes.has("STRUCTURAL_LAYOUT_CHANGE") &&
    !reasonCodes.has("LARGE_REWRITE")
  ) {
    violationReasons.push("Micro-edit patch introduced structural change.");
  }
  if (
    input.patchScope.cssRewriteSuspicion ||
    reasonCodes.has("MASSIVE_STYLE_INJECTION")
  ) {
    violationReasons.push("Micro-edit patch introduced a massive style injection.");
  }
  if (input.patchScope.totalChangedLines > MICRO_EDIT_CHANGED_LINE_LIMIT) {
    violationReasons.push("Micro-edit patch exceeded the line-change protection threshold.");
  }

  const isViolation = violationReasons.length > 0;
  return {
    isViolation,
    violationReasons,
    shouldForcePreview: isViolation,
    shouldDowngradeSafety:
      isViolation || (input.patchQuality?.qualityScore ?? 100) < 85,
  };
}
