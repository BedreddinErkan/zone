import { describe, expect, it } from "vitest";
import { decideExecutionMode } from "../decision/decideExecutionMode.js";
import { buildDecisionExplanation } from "../decision/buildDecisionExplanation.js";
import { buildRecommendation } from "../decision/buildRecommendation.js";
import { buildSavedDecisionExplanation } from "./buildSavedDecisionExplanation.js";
import { buildSavedRecommendation } from "./buildSavedRecommendation.js";
import { buildCliViewModel } from "./buildCliViewModel.js";
import { renderCliResult } from "./renderCliResult.js";
import type { SavedAgentResult, ValidationIssue } from "../../types/agent.js";

function makeSchemaErrorIssue(): ValidationIssue {
  return {
code: "SCHEMA_FIELD_MISMATCH",
      severity: "error",
    message: "Schema alignment could not be validated.",
    source: "schema",
    details: "Missing required relation mapping."
  };
}

function makeSavedBlockedResult(input: {
  recommendation: string;
}): SavedAgentResult {
  const schemaIssue = makeSchemaErrorIssue();

  return {
    version: 1,
    generatedAt: "2026-04-02T00:00:00.000Z",
    summary: "Blocked decision saved for parity testing.",
    statusLine: "STATUS: BLOCKED | confidence=0",
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
      summary: "Schema validation failed.",
      entities: ["User"],
      relations: ["User->Profile"],
      confidence: "low"
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
      schema: [schemaIssue]
    },
    issues: {
      summary: {
        total: 1,
        errors: 1,
        warnings: 0
      },
      grouped: [
        {
          key: "schema",
          label: "Schema Validation",
          total: 1,
          errors: 1,
          warnings: 0,
          issues: [schemaIssue]
        }
      ],
      topRisks: []
    },
    decision: {
      mode: "blocked",
      confidence: 0,
      reason: "Blocking validation signals were detected.",
      recommendation: input.recommendation
    },
    confidenceBreakdown: {
      finalScore: 0,
      level: "low",
      factors: {
        intentClarity: 90,
        schemaCertainty: 20,
        storageCertainty: 91,
        patchValidationHealth: 10
      }
    },
    confidenceDetails: {
      baseWeightedScore: 40,
      totalPenalty: 40,
      penalties: []
    },
    notes: {
      execution: [],
      assumptions: [],
      followUps: []
    }
  };
}

describe("pipeline blocked parity", () => {
  it("keeps live decision, saved recommendation, cli view and render output aligned for blocked flow", () => {
    const decision = decideExecutionMode({
      schemaConfidence: 92,
      storageConfidence: 91,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [
        {
code: "SCHEMA_FIELD_MISMATCH",          level: "error",
          message: "Schema alignment could not be validated.",
          details: ["Missing required relation mapping."]
        }
      ],
      hasValidatedFiles: true
    });

    expect(decision.mode).toBe("blocked");
    expect(decision.confidenceScore).toBe(0);
    expect(
      decision.reasons.some((reason) => reason.code === "SCHEMA_VALIDATION_ERROR")
    ).toBe(true);

    const liveExplanation = buildDecisionExplanation(decision);
    const liveRecommendation = buildRecommendation(decision);

    expect(liveExplanation).toContain("BLOCKED");
    expect(liveExplanation).toContain(
      "Automatic apply is not recommended until blocking issues are resolved."
    );
    expect(liveRecommendation).toBe(
      "Do not apply automatically. Resolve schema issues and verify schema alignment first."
    );

    const saved = makeSavedBlockedResult({
      recommendation: liveRecommendation
    });

    const savedExplanation = buildSavedDecisionExplanation(saved);
    const savedRecommendation = buildSavedRecommendation(saved);
    const view = buildCliViewModel(saved);
    const detailedOutput = renderCliResult(view, "detailed");
    const summaryOutput = renderCliResult(view, "summary");

    expect(savedExplanation).toContain("BLOCKED");
    expect(savedExplanation).toContain(
      "Automatic apply is not recommended until blocking issues are resolved."
    );

    expect(savedRecommendation).toBe(liveRecommendation);

    expect(view.decisionMode).toBe("blocked");
    expect(view.decisionLabel).toBe("BLOCKED");
    expect(view.confidenceScore).toBe(0);
    expect(view.recommendation).toBe(liveRecommendation);
    expect(view.errorCount).toBe(1);
    expect(view.warningCount).toBe(0);

    expect(detailedOutput).toContain("Decision: BLOCKED");
    expect(detailedOutput).toContain(`Recommendation\n${liveRecommendation}`);
    expect(detailedOutput).toContain(`Explanation\n${savedExplanation}`);

    expect(summaryOutput).toContain("Decision: BLOCKED");
    expect(summaryOutput).toContain(`Recommendation: ${liveRecommendation}`);
  });
});