"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const renderDecisionSummary_js_1 = require("./renderDecisionSummary.js");
(0, vitest_1.describe)("renderSavedAgentResultSummary", () => {
    (0, vitest_1.it)("renders saved agent result with recommendation, top risks and groups", () => {
        const result = {
            summary: "Example summary",
            statusLine: "STATUS: preview_only | confidence=64 | warnings=3",
            intent: {
                rawTask: "add endpoint",
                operation: "update",
                target: "treatment",
                scope: "single",
                nestedTarget: "timeline",
                confidence: "medium",
                warnings: []
            },
            schema: {
                summary: "Schema summary",
                entities: ["treatments"],
                relations: [],
                confidence: "medium"
            },
            storage: {
                primaryStorage: "postgres",
                detectedClients: [],
                confidence: "medium",
                reasoning: ["Detected postgres"],
                resourceStorageKind: "separate_table"
            },
            validation: {
                patch: [],
                schema: []
            },
            decision: {
                mode: "preview",
                confidence: 64,
                reason: "Warnings detected",
                recommendation: "Preview çıktısını manuel incele. Warning ve risk sinyalleri temizlenmeden otomatik apply önerilmez."
            },
            confidenceDetails: {
                baseWeightedScore: 72,
                totalPenalty: 8,
                penalties: []
            },
            confidenceBreakdown: {
                finalScore: 64,
                level: "medium",
                factors: {
                    intentClarity: 80,
                    schemaCertainty: 58,
                    storageCertainty: 55,
                    patchValidationHealth: 70
                }
            },
            issues: {
                summary: {
                    total: 3,
                    errors: 1,
                    warnings: 2
                },
                grouped: [
                    {
                        key: "schema",
                        label: "Schema validation",
                        total: 1,
                        errors: 1,
                        warnings: 0,
                        issues: [
                            {
                                code: "SCHEMA_VALIDATION_ERROR",
                                severity: "error",
                                message: "Table not found"
                            }
                        ]
                    },
                    {
                        key: "risk",
                        label: "Patch risk warnings",
                        total: 2,
                        errors: 0,
                        warnings: 2,
                        issues: [
                            {
                                code: "PATCH_RISK_WARNING",
                                severity: "warning",
                                message: "Possible tenant scope issue"
                            }
                        ]
                    }
                ],
                topRisks: [
                    {
                        code: "SCHEMA_VALIDATION_ERROR",
                        severity: "error",
                        message: "Table not found"
                    },
                    {
                        code: "PATCH_RISK_WARNING",
                        severity: "warning",
                        message: "Possible tenant scope issue"
                    }
                ]
            },
            notes: {
                execution: [],
                assumptions: [],
                followUps: []
            }
        };
        const output = (0, renderDecisionSummary_js_1.renderSavedAgentResultSummary)(result);
        (0, vitest_1.expect)(output).toContain("=== AGENT DECISION ===");
        (0, vitest_1.expect)(output).toContain("Mode: preview");
        (0, vitest_1.expect)(output).toContain("Confidence: 64/100 (medium)");
        (0, vitest_1.expect)(output).toContain("Recommendation:");
        (0, vitest_1.expect)(output).toContain("Top Risks:");
        (0, vitest_1.expect)(output).toContain("SCHEMA_VALIDATION_ERROR");
        (0, vitest_1.expect)(output).toContain("Issue Groups:");
        (0, vitest_1.expect)(output).toContain("Schema validation: 1 error, 0 warning");
        (0, vitest_1.expect)(output).toContain("Summary:");
    });
});
//# sourceMappingURL=renderDecisionSummary.test.js.map