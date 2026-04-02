import { describe, expect, it } from "vitest";
import { decideExecutionMode } from "../decision/decideExecutionMode.js";
import { buildDecisionExplanation } from "../decision/buildDecisionExplanation.js";
import { buildRecommendation } from "../decision/buildRecommendation.js";
import { buildSavedDecisionExplanation } from "./buildSavedDecisionExplanation.js";
import { buildSavedRecommendation } from "./buildSavedRecommendation.js";
import { buildCliViewModel } from "./buildCliViewModel.js";
import { renderCliResult } from "./renderCliResult.js";
import type { SavedAgentResult } from "../../types/agent.js";

function makeSavedApplyResult(input: {
  confidence: number;
  recommendation: string;
}): SavedAgentResult {
  return {
    version: 1,
    generatedAt: "2026-04-02T00:00:00.000Z",
    summary: "Safe-to-apply decision saved for parity testing.",
    statusLine: `STATUS: APPLY | confidence=${input.confidence}`,
    intent: {
      rawTask: "test task",
      operation: "update",
      target: "user",
      scope: "single",
      nestedTarget: null,
      confidence: "high",
      warnings: []
    },
    schema: {
      summary: "Schema signals look healthy.",
      entities: ["User"],
      relations: ["User->Profile"],
      confidence: "high"
    },
    storage: {
      primaryStorage: "postgres",
      detectedClients: [],
      confidence: "high",
      reasoning: [],
      resourceStorageKind: "separate_table"
    },
    validation: {
      patch: [],
      schema: []
    },
    issues: {
      summary: {
        total: 0,
        errors: 0,
        warnings: 0
      },
      grouped: [],
      topRisks: []
    },
    decision: {
      mode: "apply",
      confidence: input.confidence,
      reason: "No blocking or warning-level execution risks were detected.",
      recommendation: input.recommendation
    },
    confidenceBreakdown: {
      finalScore: input.confidence,
      level: "high",
      factors: {
        intentClarity: 92,
        schemaCertainty: 94,
        storageCertainty: 93,
        patchValidationHealth: 95
      }
    },
    confidenceDetails: {
      baseWeightedScore: input.confidence,
      totalPenalty: 0,
      penalties: []
    },
    notes: {
      execution: [],
      assumptions: [],
      followUps: []
    }
  };
}

describe("pipeline safe_to_apply parity", () => {
  it("keeps live decision, saved recommendation, cli view and render output aligned for safe_to_apply flow", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 94,
      storageConfidence: 93,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true
    });

    expect(decision.mode).toBe("safe_to_apply");
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]?.code).toBe("SAFE_TO_APPLY");

    const liveExplanation = buildDecisionExplanation(decision);
    const liveRecommendation = buildRecommendation(decision);

    expect(liveExplanation).toContain("SAFE TO APPLY");
    expect(liveExplanation).toContain(
      "Automatic apply can proceed under the current safeguards."
    );
    expect(liveRecommendation).toBe(
      "Patch can be applied automatically under current safeguards."
    );

    const saved = makeSavedApplyResult({
      confidence: decision.confidenceScore,
      recommendation: liveRecommendation
    });

    const savedExplanation = buildSavedDecisionExplanation(saved);
    const savedRecommendation = buildSavedRecommendation(saved);
    const view = buildCliViewModel(saved);
    const detailedOutput = renderCliResult(view, "detailed");
    const summaryOutput = renderCliResult(view, "summary");

    expect(savedExplanation).toContain("SAFE TO APPLY");
    expect(savedExplanation).toContain(
      "Automatic apply can proceed under the current safeguards."
    );

    expect(savedRecommendation).toBe(liveRecommendation);

    expect(view.decisionMode).toBe("apply");
    expect(view.decisionLabel).toBe("SAFE TO APPLY");
    expect(view.confidenceScore).toBe(decision.confidenceScore);
    expect(view.recommendation).toBe(liveRecommendation);
    expect(view.errorCount).toBe(0);
    expect(view.warningCount).toBe(0);

    expect(detailedOutput).toContain("Decision: SAFE TO APPLY");
    expect(detailedOutput).toContain(`Recommendation\n${liveRecommendation}`);
    expect(detailedOutput).toContain(`Explanation\n${savedExplanation}`);

    expect(summaryOutput).toContain("Decision: SAFE TO APPLY");
    expect(summaryOutput).toContain(`Recommendation: ${liveRecommendation}`);
  });
});