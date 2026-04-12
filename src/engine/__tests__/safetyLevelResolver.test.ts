import { describe, expect, it } from "vitest";
import {
  resolveSafetyLevel,
  type SafetyLevelResolverInput,
} from "../safetyLevelResolver.js";

function buildInput(
  overrides: Partial<SafetyLevelResolverInput> = {}
): SafetyLevelResolverInput {
  return {
    hasBlockedPatch: false,
    developerConfidence: 92,
    decisionMode: "safe_to_apply",
    developerRiskScore: 0,
    intentMismatch: {
      hasMismatch: false,
      severity: "none",
    },
    patchQuality: {
      qualityScore: 94,
    },
    ...overrides,
  };
}

describe("resolveSafetyLevel", () => {
  it("returns a strong safe level for a clean high-quality patch", () => {
    const result = resolveSafetyLevel(buildInput());

    expect(result.safetyLevel).toBe("safe_auto_apply");
    expect(result.safetyReasons).toContain(
      "High confidence, low risk, and strong quality allow auto-apply."
    );
  });

  it("downgrades mismatch-driven cases to preview_only", () => {
    const result = resolveSafetyLevel(
      buildInput({
        developerConfidence: 55,
        decisionMode: "preview_only",
        intentMismatch: {
          hasMismatch: true,
          severity: "medium",
        },
      })
    );

    expect(result.safetyLevel).toBe("preview_only");
    expect(result.safetyReasons).toContain(
      "Intent mismatch requires manual preview."
    );
    expect(result.confidenceAdjusted).toBe(55);
  });

  it("marks blocked or high-risk cases as high_risk_blocked", () => {
    const result = resolveSafetyLevel(
      buildInput({
        hasBlockedPatch: true,
      })
    );

    expect(result.safetyLevel).toBe("high_risk_blocked");
    expect(result.safetyReasons).toContain(
      "Patch validation produced a blocking result."
    );
  });

  it("uses safe_with_review for lower-grade but non-blocking results", () => {
    const result = resolveSafetyLevel(
      buildInput({
        developerConfidence: 78,
        developerRiskScore: 25,
        patchQuality: {
          qualityScore: 80,
        },
      })
    );

    expect(result.safetyLevel).toBe("safe_with_review");
  });
});
