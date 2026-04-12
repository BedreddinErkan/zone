import { describe, expect, it } from "vitest";
import {
  detectIntentMismatch,
  type IntentMismatchDetectorInput,
} from "../intentMismatchDetector.js";

function buildInput(
  overrides: Partial<IntentMismatchDetectorInput> = {}
): IntentMismatchDetectorInput {
  return {
    taskIntent: "standard",
    patchScope: {
      changedFileCount: 1,
      totalAddedLines: 3,
      totalRemovedLines: 2,
      totalChangedLines: 5,
      rewriteLikeSuspicion: false,
      cssRewriteSuspicion: false,
    },
    ...overrides,
  };
}

describe("detectIntentMismatch", () => {
  it("returns no mismatch for non-micro intents", () => {
    const result = detectIntentMismatch(buildInput());

    expect(result.hasMismatch).toBe(false);
    expect(result.severity).toBe("none");
    expect(result.reasonCodes).toEqual([]);
    expect(result.forcePreviewOnly).toBe(false);
  });

  it("flags a large rewrite for micro-edit intents", () => {
    const result = detectIntentMismatch(
      buildInput({
        taskIntent: "micro_edit",
        patchScope: {
          changedFileCount: 1,
          totalAddedLines: 95,
          totalRemovedLines: 90,
          totalChangedLines: 185,
          rewriteLikeSuspicion: true,
          cssRewriteSuspicion: false,
        },
      })
    );

    expect(result.hasMismatch).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.reasonCodes).toContain("LARGE_REWRITE");
    expect(result.reasonCodes).toContain("STRUCTURAL_LAYOUT_CHANGE");
    expect(result.forcePreviewOnly).toBe(true);
    expect(result.confidenceCap).toBe(55);
  });

  it("flags multi-file expansion for micro-edit intents", () => {
    const result = detectIntentMismatch(
      buildInput({
        taskIntent: "micro_edit",
        patchScope: {
          changedFileCount: 3,
          totalAddedLines: 18,
          totalRemovedLines: 6,
          totalChangedLines: 24,
          rewriteLikeSuspicion: false,
          cssRewriteSuspicion: false,
        },
      })
    );

    expect(result.hasMismatch).toBe(true);
    expect(result.severity).toBe("medium");
    expect(result.reasonCodes).toEqual([
      "MULTI_FILE_EXPANSION",
      "LARGE_CHANGED_LINE_COUNT",
    ]);
    expect(result.forcePreviewOnly).toBe(false);
  });

  it("returns no mismatch for a clean micro-edit", () => {
    const result = detectIntentMismatch(
      buildInput({
        taskIntent: "micro_edit",
      })
    );

    expect(result.hasMismatch).toBe(false);
    expect(result.severity).toBe("none");
    expect(result.reasonCodes).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
