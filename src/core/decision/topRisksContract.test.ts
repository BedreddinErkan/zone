import { describe, expect, it } from "vitest";
import { buildRecommendation } from "./buildRecommendation.js";
import type { DecideExecutionModeResult } from "./decideExecutionMode.js";
import type { ScoredRisk } from "../../types/agent.js";

function makeBaseDecision(): DecideExecutionModeResult {
  return {
    mode: "preview_only",
    confidenceScore: 80,
    reasons: [
      {
        code: "MISSING_VALIDATED_FILES",
        severity: "warning",
        message: "Validated file coverage is incomplete."
      }
    ]
  };
}

function makeHighRisk(): ScoredRisk {
  return {
    id: "risk:test",
    title: "High risk change",
    description: "Potential dangerous change",
    severity: "high",
    score: 90,
    category: "patch",
    source: "derived"
  };
}

describe("topRisks contract behavior", () => {
  it("falls back to patch-scope recommendation when topRisks is undefined", () => {
    const decision = makeBaseDecision();

    const recommendation = buildRecommendation(decision);

    expect(recommendation).toBe(
      "Preview the patch and review patch scope before any apply step."
    );
  });

  it("switches to high-risk recommendation when high severity topRisk exists", () => {
    const decision = {
      ...makeBaseDecision(),
      topRisks: [makeHighRisk()]
    };

    const recommendation = buildRecommendation(decision);

    expect(recommendation).toBe(
      "Preview the patch and complete manual review before any apply step because high-severity risks are still present."
    );
  });
});