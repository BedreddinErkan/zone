import { describe, expect, it } from "vitest";
import { decideExecutionMode } from "../decision/decideExecutionMode.js";
import { buildDecisionExplanation } from "../decision/buildDecisionExplanation.js";
import { buildRecommendation } from "../decision/buildRecommendation.js";
import { buildSavedDecisionExplanation } from "./buildSavedDecisionExplanation.js";
import { buildSavedRecommendation } from "./buildSavedRecommendation.js";
import { buildCliViewModel } from "./buildCliViewModel.js";
import { renderCliResult } from "./renderCliResult.js";
import type { SavedAgentResult, ValidationIssue } from "../../types/agent.js";

function makeMissingValidatedFilesIssue(): ValidationIssue {
  return {
    code: "MISSING_VALIDATED_FILES",
    severity: "warning",
    message: "Validated file coverage is incomplete.",
    source: "confidence"
  };
}

function makeSavedPreviewResult(input: {
  confidence: number;
  recommendation: string;
}): SavedAgentResult {
  const missingValidatedFilesIssue = makeMissingValidatedFilesIssue();

  return {
    version: 1,
    generatedAt: "2026-04-02T00:00:00.000Z",
    summary: "Preview-only decision saved for parity testing.",
    statusLine: `STATUS: PREVIEW | confidence=${input.confidence}`,
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
      summary: "No schema issues detected.",
      entities: [],
      relations: [],
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
        total: 1,
        errors: 0,
        warnings: 1
      },
      grouped: [
        {
          key: "confidence",
          label: "Confidence Signals",
          total: 1,
          errors: 0,
          warnings: 1,
          issues: [missingValidatedFilesIssue]
        }
      ],
      topRisks: []
    },
    decision: {
      mode: "preview",
      confidence: input.confidence,
      reason: "Manual review is required before apply.",
      recommendation: input.recommendation
    },
    confidenceBreakdown: {
      finalScore: input.confidence,
      level: "medium",
      factors: {
        intentClarity: 90,
        schemaCertainty: 92,
        storageCertainty: 91,
        patchValidationHealth: 55
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

describe("pipeline preview parity", () => {
  it("keeps live decision, saved recommendation, cli view and render output aligned for preview flow", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 92,
      storageConfidence: 91,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: false
    });

    expect(decision.mode).toBe("preview_only");
    expect(decision.reasons.some((reason) => reason.code === "MISSING_VALIDATED_FILES")).toBe(
      true
    );

    const liveExplanation = buildDecisionExplanation(decision);
    const liveRecommendation = buildRecommendation(decision);

    expect(liveExplanation).toContain("PREVIEW ONLY");
    expect(liveExplanation).toContain("Automatic apply is not recommended until review is completed.");
    expect(liveRecommendation).toBe(
      "Preview the patch and review patch scope before any apply step."
    );

    const saved = makeSavedPreviewResult({
      confidence: decision.confidenceScore,
      recommendation: liveRecommendation
    });

    const savedExplanation = buildSavedDecisionExplanation(saved);
    const savedRecommendation = buildSavedRecommendation(saved);
    const view = buildCliViewModel(saved);
    const detailedOutput = renderCliResult(view, "detailed");
    const summaryOutput = renderCliResult(view, "summary");

    expect(savedExplanation).toContain("PREVIEW ONLY");
    expect(savedExplanation).toContain(
      "Automatic apply is not recommended until review is completed."
    );

    expect(savedRecommendation).toBe(liveRecommendation);

    expect(view.decisionMode).toBe("preview");
    expect(view.decisionLabel).toBe("PREVIEW ONLY");
    expect(view.confidenceScore).toBe(decision.confidenceScore);
    expect(view.recommendation).toBe(liveRecommendation);
    expect(view.errorCount).toBe(0);
    expect(view.warningCount).toBe(1);

    expect(detailedOutput).toContain("Decision: PREVIEW ONLY");
    expect(detailedOutput).toContain(`Recommendation\n${liveRecommendation}`);
    expect(detailedOutput).toContain(`Explanation\n${savedExplanation}`);

    expect(summaryOutput).toContain("Decision: PREVIEW ONLY");
    expect(summaryOutput).toContain(`Recommendation: ${liveRecommendation}`);
  });
});