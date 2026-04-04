"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const decideExecutionMode_js_1 = require("../decision/decideExecutionMode.js");
const buildDecisionExplanation_js_1 = require("../decision/buildDecisionExplanation.js");
const buildRecommendation_js_1 = require("../decision/buildRecommendation.js");
const buildSavedDecisionExplanation_js_1 = require("./buildSavedDecisionExplanation.js");
const buildSavedRecommendation_js_1 = require("./buildSavedRecommendation.js");
const buildCliViewModel_js_1 = require("./buildCliViewModel.js");
const renderCliResult_js_1 = require("./renderCliResult.js");
function makeMissingValidatedFilesIssue() {
    return {
        code: "MISSING_VALIDATED_FILES",
        severity: "warning",
        message: "Validated file coverage is incomplete.",
        source: "confidence"
    };
}
function makeHighRisk() {
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
function makeSavedPreviewResult(input) {
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
(0, vitest_1.describe)("pipeline high-risk preview parity", () => {
    (0, vitest_1.it)("uses high top risk signals consistently across live, saved and rendered outputs", () => {
        const baseDecision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 92,
            storageConfidence: 91,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: false
        });
        (0, vitest_1.expect)(baseDecision.mode).toBe("preview_only");
        const highRisk = makeHighRisk();
        const decision = {
            ...baseDecision,
            topRisks: [highRisk]
        };
        const liveExplanation = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)(decision);
        const liveRecommendation = (0, buildRecommendation_js_1.buildRecommendation)(decision);
        (0, vitest_1.expect)(liveExplanation).toContain("PREVIEW ONLY");
        (0, vitest_1.expect)(liveExplanation).toContain("- 1 warning-level reason(s) affected the decision");
        (0, vitest_1.expect)(liveExplanation).toContain("- 1 medium/high top risk(s) remain visible in the result");
        (0, vitest_1.expect)(liveRecommendation).toBe("Preview the patch and complete manual review before any apply step because high-severity risks are still present.");
        const saved = makeSavedPreviewResult({
            confidence: decision.confidenceScore,
            recommendation: liveRecommendation,
            topRisks: [highRisk]
        });
        const savedExplanation = (0, buildSavedDecisionExplanation_js_1.buildSavedDecisionExplanation)(saved);
        const savedRecommendation = (0, buildSavedRecommendation_js_1.buildSavedRecommendation)(saved);
        const view = (0, buildCliViewModel_js_1.buildCliViewModel)(saved);
        const detailedOutput = (0, renderCliResult_js_1.renderCliResult)(view, "detailed");
        const summaryOutput = (0, renderCliResult_js_1.renderCliResult)(view, "summary");
        (0, vitest_1.expect)(savedExplanation).toContain("PREVIEW ONLY");
        (0, vitest_1.expect)(savedExplanation).toContain("- 1 warning-level issue(s) remain in the saved result");
        (0, vitest_1.expect)(savedExplanation).toContain("- 1 medium/high top risk(s) remain visible in the saved result");
        (0, vitest_1.expect)(savedRecommendation).toBe(liveRecommendation);
        (0, vitest_1.expect)(view.decisionMode).toBe("preview");
        (0, vitest_1.expect)(view.decisionLabel).toBe("PREVIEW ONLY");
        (0, vitest_1.expect)(view.recommendation).toBe(liveRecommendation);
        (0, vitest_1.expect)(view.topRisks).toHaveLength(1);
        (0, vitest_1.expect)(view.topRisks[0]?.severity).toBe("HIGH");
        (0, vitest_1.expect)(view.topRisks[0]?.title).toBe(highRisk.title);
        (0, vitest_1.expect)(detailedOutput).toContain("Decision: PREVIEW ONLY");
        (0, vitest_1.expect)(detailedOutput).toContain(`Recommendation\n${liveRecommendation}`);
        (0, vitest_1.expect)(detailedOutput).toContain("Top Risks (prioritized)");
        (0, vitest_1.expect)(detailedOutput).toContain(`[HIGH] score=${highRisk.score} | ${highRisk.title} (${highRisk.category})`);
        (0, vitest_1.expect)(summaryOutput).toContain("Decision: PREVIEW ONLY");
        (0, vitest_1.expect)(summaryOutput).toContain(`Recommendation: ${liveRecommendation}`);
        (0, vitest_1.expect)(summaryOutput).toContain(`Top Risk: HIGH (score: ${highRisk.score}) - ${highRisk.title}`);
    });
});
//# sourceMappingURL=pipelineHighRiskPreviewParity.test.js.map