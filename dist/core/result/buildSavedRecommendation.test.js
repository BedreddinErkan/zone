"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildSavedRecommendation_js_1 = require("./buildSavedRecommendation.js");
function createBaseResult(overrides) {
    return {
        summary: "Example summary",
        intent: {
            rawTask: "add endpoint",
            operation: "modify",
            target: "endpoint",
            scope: "server",
            nestedTarget: null,
            confidence: "medium",
            warnings: []
        },
        schema: {
            summary: "Schema summary",
            entities: [],
            relations: [],
            confidence: "medium"
        },
        storage: {
            primaryStorage: "postgres",
            detectedClients: [],
            confidence: "medium",
            reasoning: ["Detected postgres"]
        },
        validation: {
            patch: [],
            schema: []
        },
        decision: {
            mode: "preview",
            confidence: 72,
            reason: "Warnings require review."
        },
        confidenceDetails: {
            baseWeightedScore: 80,
            totalPenalty: 8,
            penalties: []
        },
        notes: {
            execution: [],
            assumptions: [],
            followUps: []
        },
        ...overrides
    };
}
(0, vitest_1.describe)("buildSavedRecommendation", () => {
    (0, vitest_1.it)("prefers explicit saved recommendation when provided", () => {
        const result = createBaseResult({
            decision: {
                mode: "preview",
                confidence: 72,
                reason: "Warnings require review.",
                recommendation: "Use the saved recommendation text."
            }
        });
        (0, vitest_1.expect)((0, buildSavedRecommendation_js_1.buildSavedRecommendation)(result)).toBe("Use the saved recommendation text.");
    });
    (0, vitest_1.it)("returns schema-focused blocked recommendation when schema issues exist", () => {
        const result = createBaseResult({
            decision: {
                mode: "blocked",
                confidence: 20,
                reason: "Blocking issues detected."
            },
            validation: {
                patch: [],
                schema: [
                    {
                        code: "SCHEMA_VALIDATION_ERROR",
                        severity: "error",
                        message: "Schema validation failed."
                    }
                ]
            }
        });
        (0, vitest_1.expect)((0, buildSavedRecommendation_js_1.buildSavedRecommendation)(result)).toBe("Do not apply automatically. Resolve schema issues and verify schema alignment first.");
    });
    (0, vitest_1.it)("returns high-risk preview recommendation when high top risk exists", () => {
        const result = createBaseResult({
            decision: {
                mode: "preview",
                confidence: 68,
                reason: "Warnings require review."
            },
            issues: {
                summary: {
                    total: 1,
                    errors: 0,
                    warnings: 1
                },
                grouped: [],
                topRisks: [
                    {
                        id: "risk-1",
                        title: "Dangerous patch target",
                        description: "Patch may affect risky files.",
                        severity: "high",
                        score: 90,
                        category: "patch",
                        source: "warning"
                    }
                ]
            }
        });
        (0, vitest_1.expect)((0, buildSavedRecommendation_js_1.buildSavedRecommendation)(result)).toBe("Preview the patch and complete manual review before any apply step because high-severity risks are still present.");
    });
    (0, vitest_1.it)("returns patch-focused preview recommendation when patch issues exist", () => {
        const result = createBaseResult({
            validation: {
                patch: [
                    {
                        code: "PATCH_VALIDATION_WARNING",
                        severity: "warning",
                        message: "Patch should be reviewed."
                    }
                ],
                schema: []
            }
        });
        (0, vitest_1.expect)((0, buildSavedRecommendation_js_1.buildSavedRecommendation)(result)).toBe("Preview the patch and review patch scope before any apply step.");
    });
    (0, vitest_1.it)("returns safe recommendation for apply mode", () => {
        const result = createBaseResult({
            decision: {
                mode: "apply",
                confidence: 91,
                reason: "Validation passed cleanly."
            }
        });
        (0, vitest_1.expect)((0, buildSavedRecommendation_js_1.buildSavedRecommendation)(result)).toBe("Patch can be applied automatically under current safeguards.");
    });
});
//# sourceMappingURL=buildSavedRecommendation.test.js.map