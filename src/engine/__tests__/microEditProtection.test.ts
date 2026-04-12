import { describe, expect, it } from "vitest";
import {
  enforceMicroEditProtection,
  type MicroEditProtectionInput,
} from "../microEditProtection.js";

function buildInput(
  overrides: Partial<MicroEditProtectionInput> = {}
): MicroEditProtectionInput {
  return {
    taskIntent: "micro_edit",
    patchScope: {
      changedFileCount: 1,
      totalAddedLines: 3,
      totalRemovedLines: 2,
      totalChangedLines: 5,
      rewriteLikeSuspicion: false,
      cssRewriteSuspicion: false,
    },
    intentMismatch: {
      hasMismatch: false,
      severity: "none",
      reasonCodes: [],
    },
    patchQuality: {
      qualityScore: 95,
    },
    ...overrides,
  };
}

describe("enforceMicroEditProtection", () => {
  it("returns no violation for a valid micro edit", () => {
    const result = enforceMicroEditProtection(buildInput());

    expect(result.isViolation).toBe(false);
    expect(result.violationReasons).toEqual([]);
  });

  it("flags a large rewrite micro edit as a violation", () => {
    const result = enforceMicroEditProtection(
      buildInput({
        patchScope: {
          changedFileCount: 1,
          totalAddedLines: 80,
          totalRemovedLines: 70,
          totalChangedLines: 150,
          rewriteLikeSuspicion: true,
          cssRewriteSuspicion: false,
        },
      })
    );

    expect(result.isViolation).toBe(true);
    expect(result.violationReasons).toContain(
      "Micro-edit patch expanded into a large rewrite."
    );
  });

  it("flags multi-file micro edits as a violation", () => {
    const result = enforceMicroEditProtection(
      buildInput({
        patchScope: {
          changedFileCount: 2,
          totalAddedLines: 8,
          totalRemovedLines: 6,
          totalChangedLines: 14,
          rewriteLikeSuspicion: false,
          cssRewriteSuspicion: false,
        },
      })
    );

    expect(result.isViolation).toBe(true);
    expect(result.violationReasons).toContain(
      "Micro-edit patch changed multiple files."
    );
  });

  it("flags structural micro edits as a violation", () => {
    const result = enforceMicroEditProtection(
      buildInput({
        intentMismatch: {
          hasMismatch: true,
          severity: "high",
          reasonCodes: ["STRUCTURAL_LAYOUT_CHANGE"],
        },
      })
    );

    expect(result.isViolation).toBe(true);
    expect(result.violationReasons).toContain(
      "Micro-edit patch introduced structural change."
    );
  });
});
