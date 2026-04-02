import { describe, expect, it } from "vitest";
import { renderDecisionSummary } from "./renderDecisionSummary.js";
import { buildRecommendation } from "./buildRecommendation.js";
import type { DecideExecutionModeResult } from "./decideExecutionMode.js";

describe("renderDecisionSummary recommendation parity", () => {
  it("uses the same recommendation wording as buildRecommendation for preview_only patch-scope flow", () => {
    const result: DecideExecutionModeResult = {
      mode: "preview_only",
      confidenceScore: 84,
      reasons: [
        {
          code: "MISSING_VALIDATED_FILES",
          severity: "warning",
          message: "Validated file coverage is incomplete."
        }
      ],
      topRisks: []
    };

    const expectedRecommendation = buildRecommendation(result);
    const rendered = renderDecisionSummary(result);

    expect(expectedRecommendation).toBe(
      "Preview the patch and review patch scope before any apply step."
    );

    expect(rendered).toContain("Recommendation:");
    expect(rendered).toContain(expectedRecommendation);
  });
});