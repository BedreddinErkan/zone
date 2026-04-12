import type { DeveloperPatchScope } from "../core/runLlmPatchFlow.js";
import type {
  IntentMismatchDetectorResult,
  TaskIntent,
} from "./intentMismatchDetector.js";

export interface PatchQualityScorerInput {
  taskIntent: TaskIntent;
  patchScope: DeveloperPatchScope;
  validationWarnings?: string[];
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
