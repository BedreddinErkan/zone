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
function makeSchemaErrorIssue() {
    return {
        code: "SCHEMA_FIELD_MISMATCH",
        severity: "error",
        message: "Schema alignment could not be validated.",
        source: "schema",
        details: "Missing required relation mapping."
    };
}
function makeSavedBlockedResult(input) {
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
(0, vitest_1.describe)("pipeline blocked parity", () => {
    (0, vitest_1.it)("keeps live decision, saved recommendation, cli view and render output aligned for blocked flow", () => {
        const decision = (0, decideExecutionMode_js_1.decideExecutionMode)({
            schemaConfidence: 92,
            storageConfidence: 91,
            architectureWarnings: [],
            patchRiskWarnings: [],
            patchValidationIssues: [],
            schemaValidationIssues: [
                {
                    code: "SCHEMA_FIELD_MISMATCH", level: "error",
                    message: "Schema alignment could not be validated.",
                    details: ["Missing required relation mapping."]
                }
            ],
            hasValidatedFiles: true
        });
        (0, vitest_1.expect)(decision.mode).toBe("blocked");
        (0, vitest_1.expect)(decision.confidenceScore).toBe(0);
        (0, vitest_1.expect)(decision.reasons.some((reason) => reason.code === "SCHEMA_VALIDATION_ERROR")).toBe(true);
        const liveExplanation = (0, buildDecisionExplanation_js_1.buildDecisionExplanation)(decision);
        const liveRecommendation = (0, buildRecommendation_js_1.buildRecommendation)(decision);
        (0, vitest_1.expect)(liveExplanation).toContain("BLOCKED");
        (0, vitest_1.expect)(liveExplanation).toContain("Automatic apply is not recommended until blocking issues are resolved.");
        (0, vitest_1.expect)(liveRecommendation).toBe("Do not apply automatically. Resolve schema issues and verify schema alignment first.");
        const saved = makeSavedBlockedResult({
            recommendation: liveRecommendation
        });
        const savedExplanation = (0, buildSavedDecisionExplanation_js_1.buildSavedDecisionExplanation)(saved);
        const savedRecommendation = (0, buildSavedRecommendation_js_1.buildSavedRecommendation)(saved);
        const view = (0, buildCliViewModel_js_1.buildCliViewModel)(saved);
        const detailedOutput = (0, renderCliResult_js_1.renderCliResult)(view, "detailed");
        const summaryOutput = (0, renderCliResult_js_1.renderCliResult)(view, "summary");
        (0, vitest_1.expect)(savedExplanation).toContain("BLOCKED");
        (0, vitest_1.expect)(savedExplanation).toContain("Automatic apply is not recommended until blocking issues are resolved.");
        (0, vitest_1.expect)(savedRecommendation).toBe(liveRecommendation);
        (0, vitest_1.expect)(view.decisionMode).toBe("blocked");
        (0, vitest_1.expect)(view.decisionLabel).toBe("BLOCKED");
        (0, vitest_1.expect)(view.confidenceScore).toBe(0);
        (0, vitest_1.expect)(view.recommendation).toBe(liveRecommendation);
        (0, vitest_1.expect)(view.errorCount).toBe(1);
        (0, vitest_1.expect)(view.warningCount).toBe(0);
        (0, vitest_1.expect)(detailedOutput).toContain("Decision: BLOCKED");
        (0, vitest_1.expect)(detailedOutput).toContain(`Recommendation\n${liveRecommendation}`);
        (0, vitest_1.expect)(detailedOutput).toContain(`Explanation\n${savedExplanation}`);
        (0, vitest_1.expect)(summaryOutput).toContain("Decision: BLOCKED");
        (0, vitest_1.expect)(summaryOutput).toContain(`Recommendation: ${liveRecommendation}`);
    });
});
//# sourceMappingURL=pipelineBlockedParity.test.js.map