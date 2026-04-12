import { describe, expect, it } from "vitest";
import {
  scorePatchQuality,
  type PatchQualityScorerInput,
} from "../patchQualityScorer.js";

function buildInput(
  overrides: Partial<PatchQualityScorerInput> = {}
): PatchQualityScorerInput {
  return {
    taskIntent: "micro_edit",
    patchScope: {
      changedFileCount: 1,
      totalAddedLines: 2,
      totalRemovedLines: 1,
      totalChangedLines: 3,
      rewriteLikeSuspicion: false,
      cssRewriteSuspicion: false,
    },
    validationWarnings: [],
    intentMismatch: {
      hasMismatch: false,
      severity: "none",
      warnings: [],
    },
    ...overrides,
  };
}

describe("scorePatchQuality", () => {
  it("returns a high quality score for a clean micro edit", () => {
    const result = scorePatchQuality(buildInput());

    expect(result.qualityScore).toBeGreaterThanOrEqual(90);
    expect(result.qualityWarnings).toEqual([]);
  });

  it("lowers quality score for a large rewrite", () => {
    const result = scorePatchQuality(
      buildInput({
        patchScope: {
          changedFileCount: 1,
          totalAddedLines: 95,
          totalRemovedLines: 88,
          totalChangedLines: 183,
          rewriteLikeSuspicion: true,
          cssRewriteSuspicion: false,
        },
      })
    );

    expect(result.qualityScore).toBeLessThan(70);
    expect(result.patchSizeScore).toBeLessThan(50);
    expect(result.structurePreservationScore).toBeLessThan(60);
  });

  it("adds warnings and reduces score for structural and style problems", () => {
    const result = scorePatchQuality(
      buildInput({
        patchScope: {
          changedFileCount: 2,
          totalAddedLines: 35,
          totalRemovedLines: 20,
          totalChangedLines: 55,
          rewriteLikeSuspicion: true,
          cssRewriteSuspicion: true,
        },
        validationWarnings: ["[HIGH_RISK] style injection"],
      })
    );

    expect(result.qualityWarnings).toContain(
      "Large CSS/style rewrite may bypass existing design patterns."
    );
    expect(result.designSystemComplianceScore).toBeLessThan(60);
    expect(result.qualityScore).toBeLessThan(65);
  });

  it("reduces semantic alignment when intent mismatch is present", () => {
    const result = scorePatchQuality(
      buildInput({
        intentMismatch: {
          hasMismatch: true,
          severity: "medium",
          warnings: ["Micro-edit task produced a larger-than-expected patch."],
        },
      })
    );

    expect(result.semanticAlignmentScore).toBe(70);
    expect(result.qualityWarnings).toContain(
      "Micro-edit task produced a larger-than-expected patch."
    );
  });
});
