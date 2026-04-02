import { describe, expect, it } from "vitest";
import { decideExecutionMode } from "../decision/decideExecutionMode.js";
import { buildDecisionExplanation } from "../decision/buildDecisionExplanation.js";
import { buildRecommendation } from "../decision/buildRecommendation.js";
import { buildSavedDecisionExplanation } from "./buildSavedDecisionExplanation.js";
import { buildSavedRecommendation } from "./buildSavedRecommendation.js";
import { buildCliViewModel } from "./buildCliViewModel.js";
import { renderCliResult } from "./renderCliResult.js";
import type { SavedAgentResult, ScoredRisk, ValidationIssue } from "../../types/agent.js";

function makeMissingValidatedFilesIssue(): ValidationIssue {
  return {
    code: "MISSING_VALIDATED_FILES",
    severity: "warning",
    message: "Validated file coverage is incomplete.",
    source: "confidence"
  };
}

function makeHighRisk(): ScoredRisk {
  return {
    id: "risk:high-manual-review",
    title: "Potential destructive update path",
    description: "The proposed patch may update a high-impact path that still needs manual review.",
    severity: "high",
    score: 94,
    category: "patch",
    source: "derived",
    relatedCode: "PATCH_RISK_WARNING"
  };
}

function makeSavedPreviewResult(input: {
  confidence: number;
  recommendation: string;
  topRisks: ScoredRisk[];
}): SavedAgentResult {
  const missingValidatedFilesIssue = makeMissingValidatedFilesIssue();

  return {
    version: 1,
    generatedAt: "2026-04-02T00:00:00.000Z",
    summary: "Preview-only high-risk decision saved for parity testing.",
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
      topRisks: input.topRisks
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

describe("pipeline high-risk preview parity", () => {
  it("uses high top risk signals consistently across live, saved and rendered outputs", () => {
    const baseDecision = decideExecutionMode({
      schemaConfidence: 92,
      storageConfidence: 91,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: false
    });

    expect(baseDecision.mode).toBe("preview_only");

    const highRisk = makeHighRisk();
    const decision = {
      ...baseDecision,
      topRisks: [highRisk]
    };

    const liveExplanation = buildDecisionExplanation(decision);
    const liveRecommendation = buildRecommendation(decision);

    expect(liveExplanation).toContain("PREVIEW ONLY");
    expect(liveExplanation).toContain("- 1 warning-level reason(s) affected the decision");
    expect(liveExplanation).toContain("- 1 medium/high top risk(s) remain visible in the result");
    expect(liveRecommendation).toBe(
      "Preview the patch and complete manual review before any apply step because high-severity risks are still present."
    );

    const saved = makeSavedPreviewResult({
      confidence: decision.confidenceScore,
      recommendation: liveRecommendation,
      topRisks: [highRisk]
    });

    const savedExplanation = buildSavedDecisionExplanation(saved);
    const savedRecommendation = buildSavedRecommendation(saved);
    const view = buildCliViewModel(saved);
    const detailedOutput = renderCliResult(view, "detailed");
    const summaryOutput = renderCliResult(view, "summary");

    expect(savedExplanation).toContain("PREVIEW ONLY");
    expect(savedExplanation).toContain("- 1 warning-level issue(s) remain in the saved result");
    expect(savedExplanation).toContain(
      "- 1 medium/high top risk(s) remain visible in the saved result"
    );

    expect(savedRecommendation).toBe(liveRecommendation);

    expect(view.decisionMode).toBe("preview");
    expect(view.decisionLabel).toBe("PREVIEW ONLY");
    expect(view.recommendation).toBe(liveRecommendation);
    expect(view.topRisks).toHaveLength(1);
    expect(view.topRisks[0]?.severity).toBe("HIGH");
    expect(view.topRisks[0]?.title).toBe(highRisk.title);

    expect(detailedOutput).toContain("Decision: PREVIEW ONLY");
    expect(detailedOutput).toContain(`Recommendation\n${liveRecommendation}`);
    expect(detailedOutput).toContain("Top Risks (prioritized)");
    expect(detailedOutput).toContain(`[HIGH] score=${highRisk.score} | ${highRisk.title} (${highRisk.category})`);

    expect(summaryOutput).toContain("Decision: PREVIEW ONLY");
    expect(summaryOutput).toContain(`Recommendation: ${liveRecommendation}`);
    expect(summaryOutput).toContain(
      `Top Risk: HIGH (score: ${highRisk.score}) - ${highRisk.title}`
    );
  });
});