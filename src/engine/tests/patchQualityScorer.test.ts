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
    designSystemSignals: null,
    intentMismatch: {
      hasMismatch: false,
      severity: "none",
      warnings: [],
    },
    ...overrides,
  };
}

describe("scorePatchQuality design-system awareness", () => {
  it("keeps score high for a clean patch", () => {
    const result = scorePatchQuality(buildInput());

    expect(result.qualityScore).toBeGreaterThanOrEqual(90);
    expect(result.designSystemComplianceScore).toBe(100);
    expect(result.qualityWarnings).toEqual([]);
  });

  it("applies a small penalty for one inline style", () => {
    const result = scorePatchQuality(
      buildInput({
        designSystemSignals: {
          inlineStyleCount: 1,
          styleAttributeLines: 1,
          addedClassNameCount: 1,
          excessiveInlineStyles: false,
          reusableClassPreferenceMissed: false,
        },
      })
    );

    expect(result.designSystemComplianceScore).toBe(96);
    expect(result.qualityWarnings).toContain(
      "Inline styles detected instead of using existing UI classes"
    );
  });

  it("reduces design system compliance more for multiple inline styles", () => {
    const result = scorePatchQuality(
      buildInput({
        designSystemSignals: {
          inlineStyleCount: 3,
          styleAttributeLines: 3,
          addedClassNameCount: 1,
          excessiveInlineStyles: true,
          reusableClassPreferenceMissed: false,
        },
      })
    );

    expect(result.designSystemComplianceScore).toBe(73);
    expect(result.qualityWarnings).toContain(
      "Excessive inline style usage reduces design system consistency"
    );
  });

  it("adds a warning when inline styles are used without class-based styling", () => {
    const result = scorePatchQuality(
      buildInput({
        designSystemSignals: {
          inlineStyleCount: 2,
          styleAttributeLines: 2,
          addedClassNameCount: 0,
          excessiveInlineStyles: false,
          reusableClassPreferenceMissed: true,
        },
      })
    );

    expect(result.qualityWarnings).toContain(
      "Patch does not introduce reusable class-based styling"
    );
    expect(result.designSystemComplianceScore).toBe(80);
  });
});
