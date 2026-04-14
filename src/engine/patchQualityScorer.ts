import type { DeveloperPatchScope } from "../core/runLlmPatchFlow.js";
import type {
  IntentMismatchDetectorResult,
  TaskIntent,
} from "./intentMismatchDetector.js";
import type { DesignSystemSignals } from "./designSystemSignals.js";
import { validatePatchScope } from "./patchScopeValidator.js";
import type { PatchIntentType } from "./patchScopeValidator.js";

export interface PatchQualityScorerInput {
  taskIntent: TaskIntent;
  patchScope: DeveloperPatchScope;
  validationWarnings?: string[];
  designSystemSignals?: DesignSystemSignals | null;
  intentMismatch?: Pick<
    IntentMismatchDetectorResult,
    "hasMismatch" | "severity" | "warnings"
  >;
}

export interface PatchQualityScorerResult {
  qualityScore: number;
  qualityWarnings: string[];
  patchSizeScore: number;
  structurePreservationScore: number;
  designSystemComplianceScore: number;
  semanticAlignmentScore: number;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function scorePatchQuality(
  input: PatchQualityScorerInput
): PatchQualityScorerResult {
  let patchSizeScore = 100;
  const scopeIntentType: PatchIntentType =
    (input.taskIntent as { codeIntent?: PatchIntentType }).codeIntent ??
    (input.taskIntent === "micro_edit" ? "micro_edit" : "unknown");
  let structurePreservationScore = 100;
  let designSystemComplianceScore = 100;
  let semanticAlignmentScore = 100;
  const qualityWarnings: string[] = [];

  if (input.patchScope.totalChangedLines > 80) {
    patchSizeScore -= 40;
  } else if (input.patchScope.totalChangedLines > 30) {
    patchSizeScore -= 25;
  } else if (input.patchScope.totalChangedLines > 15) {
    patchSizeScore -= 12;
  }

  if (input.patchScope.changedFileCount > 3) {
    patchSizeScore -= 18;
  } else if (input.patchScope.changedFileCount > 1) {
    patchSizeScore -= 10;
  }

  const scopeResult = validatePatchScope(
    scopeIntentType,
    input.patchScope.totalChangedLines,
    input.patchScope.changedFileCount
  );
  patchSizeScore -= scopeResult.confidencePenalty;
  if (scopeResult.hasHardViolation || scopeResult.hasSoftViolation) {
    qualityWarnings.push(...scopeResult.violations.map((v) => v.message));
  }

  if (input.patchScope.rewriteLikeSuspicion) {
    patchSizeScore -= 25;
    structurePreservationScore -= 45;
    qualityWarnings.push("Patch looks larger than a targeted change.");
  }

  if (input.taskIntent === "micro_edit" && input.patchScope.changedFileCount > 1) {
    structurePreservationScore -= 20;
    qualityWarnings.push("Micro-edit task expanded across multiple files.");
  }

  if (input.patchScope.totalChangedLines > 30) {
    structurePreservationScore -= 15;
  }

  if (input.patchScope.cssRewriteSuspicion) {
    designSystemComplianceScore -= 45;
    qualityWarnings.push("Large CSS/style rewrite may bypass existing design patterns.");
  }

  const validationPenalty = Math.min(
    20,
    (input.validationWarnings ?? []).length * 4
  );
  designSystemComplianceScore -= validationPenalty;
  const inlineStylePenalty = Math.min(
    18,
    (input.designSystemSignals?.inlineStyleCount ?? 0) * 4
  );
  designSystemComplianceScore -= inlineStylePenalty;

  if ((input.designSystemSignals?.inlineStyleCount ?? 0) > 0) {
    qualityWarnings.push(
      "Inline styles detected instead of using existing UI classes"
    );
  }

  if (input.designSystemSignals?.excessiveInlineStyles) {
    designSystemComplianceScore -= 15;
    qualityWarnings.push(
      "Excessive inline style usage reduces design system consistency"
    );
  }

  if (input.designSystemSignals?.reusableClassPreferenceMissed) {
    designSystemComplianceScore -= 12;
    qualityWarnings.push("Patch does not introduce reusable class-based styling");
  }

  if (input.intentMismatch?.hasMismatch) {
    if (input.intentMismatch.severity === "high") {
      semanticAlignmentScore -= 55;
    } else if (input.intentMismatch.severity === "medium") {
      semanticAlignmentScore -= 30;
    } else if (input.intentMismatch.severity === "low") {
      semanticAlignmentScore -= 15;
    }

    if (input.intentMismatch.warnings.length > 0) {
      qualityWarnings.push(...input.intentMismatch.warnings);
    }
  }

  patchSizeScore = clampScore(patchSizeScore);
  structurePreservationScore = clampScore(structurePreservationScore);
  designSystemComplianceScore = clampScore(designSystemComplianceScore);
  semanticAlignmentScore = clampScore(semanticAlignmentScore);

  const qualityScore = clampScore(
    patchSizeScore * 0.3 +
      structurePreservationScore * 0.25 +
      designSystemComplianceScore * 0.2 +
      semanticAlignmentScore * 0.25
  );

  return {
    qualityScore,
    qualityWarnings: [...new Set(qualityWarnings)],
    patchSizeScore,
    structurePreservationScore,
    designSystemComplianceScore,
    semanticAlignmentScore,
  };
}
