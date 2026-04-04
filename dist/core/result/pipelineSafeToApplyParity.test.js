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
function makeSavedApplyResult(input) {
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
(0, vitest_1.describe)("pipeline safe_to_apply parity", () => {
    (0, vitest_1.it)("keeps live decision, saved recommendation, cli view and render output aligned for safe_to_apply flow", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 94,
            storageConfidence: 93,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [],
            hasValidatedFiles: true
        });
        (0, vitest_1.expect)(decision.mode).toBe("safe_to_apply");
        (0, vitest_1.expect)(decision.reasons).toHaveLength(1);
        (0, vitest_1.expect)(decision.reasons[0]?.code).toBe("SAFE_TO_APPLY");
        const liveExplanation = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)(decision);
        const liveRecommendation = (0, buildRecommendation_js_1.buildRecommendation)(decision);
        (0, vitest_1.expect)(liveExplanation).toContain("SAFE TO APPLY");
        (0, vitest_1.expect)(liveExplanation).toContain("Automatic apply can proceed under the current safeguards.");
        (0, vitest_1.expect)(liveRecommendation).toBe("Patch can be applied automatically under current safeguards.");
        const saved = makeSavedApplyResult({
            confidence: decision.confidenceScore,
            recommendation: liveRecommendation
        });
        const savedExplanation = (0, buildSavedDecisionExplanation_js_1.buildSavedDecisionExplanation)(saved);
        const savedRecommendation = (0, buildSavedRecommendation_js_1.buildSavedRecommendation)(saved);
        const view = (0, buildCliViewModel_js_1.buildCliViewModel)(saved);
        const detailedOutput = (0, renderCliResult_js_1.renderCliResult)(view, "detailed");
        const summaryOutput = (0, renderCliResult_js_1.renderCliResult)(view, "summary");
        (0, vitest_1.expect)(savedExplanation).toContain("SAFE TO APPLY");
        (0, vitest_1.expect)(savedExplanation).toContain("Automatic apply can proceed under the current safeguards.");
        (0, vitest_1.expect)(savedRecommendation).toBe(liveRecommendation);
        (0, vitest_1.expect)(view.decisionMode).toBe("apply");
        (0, vitest_1.expect)(view.decisionLabel).toBe("SAFE TO APPLY");
        (0, vitest_1.expect)(view.confidenceScore).toBe(decision.confidenceScore);
        (0, vitest_1.expect)(view.recommendation).toBe(liveRecommendation);
        (0, vitest_1.expect)(view.errorCount).toBe(0);
        (0, vitest_1.expect)(view.warningCount).toBe(0);
        (0, vitest_1.expect)(detailedOutput).toContain("Decision: SAFE TO APPLY");
        (0, vitest_1.expect)(detailedOutput).toContain(`Recommendation\n${liveRecommendation}`);
        (0, vitest_1.expect)(detailedOutput).toContain(`Explanation\n${savedExplanation}`);
        (0, vitest_1.expect)(summaryOutput).toContain("Decision: SAFE TO APPLY");
        (0, vitest_1.expect)(summaryOutput).toContain(`Recommendation: ${liveRecommendation}`);
    });
});
//# sourceMappingURL=pipelineSafeToApplyParity.test.js.map