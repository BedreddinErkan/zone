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
                        id: "issue:schema_invalid",
                        title: "Schema mismatch riski",
                        description: "Patch çıktısı beklenen şemayla uyumlu değil.",
                        severity: "high",
                        score: 90,
                        category: "schema",
                        source: "validation_issue",
                        relatedCode: "SCHEMA_INVALID"
                    },
                    {
                        id: "issue:patch_warning",
                        title: "Patch riski",
                        description: "Patch yan etki riski taşıyor.",
                        severity: "medium",
                        score: 55,
                        category: "patch",
                        source: "warning",
                        relatedCode: "PATCH_WARNING"
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
        (0, vitest_1.expect)(output).toContain("Schema mismatch riski");
        // İş 2: relatedCode ve category yeni format
        (0, vitest_1.expect)(output).toContain("(schema / SCHEMA_INVALID)");
        (0, vitest_1.expect)(output).toContain("(patch / PATCH_WARNING)");
        (0, vitest_1.expect)(output).toContain("Issue Groups:");
        (0, vitest_1.expect)(output).toContain("Schema validation: 1 error, 0 warning");
        (0, vitest_1.expect)(output).toContain("Summary:");
    });
});
(0, vitest_1.it)("renders top risks when present", () => {
    const output = (0, renderDecisionSummary_js_1.renderDecisionSummary)({
        mode: "preview_only",
        confidenceScore: 72,
        reasons: [],
        topRisks: [
            {
                id: "risk-1",
                title: "Dangerous patch target",
                description: "Patch may touch risky file",
                severity: "high",
                score: 95,
                category: "patch",
                source: "warning"
            },
            {
                id: "risk-2",
                title: "Schema mismatch",
                description: "Schema confidence is limited",
                severity: "medium",
                score: 66,
                category: "schema",
                source: "derived"
            }
        ]
    });
    (0, vitest_1.expect)(output).toContain("Top Risks:");
    (0, vitest_1.expect)(output).toContain("- [HIGH] Dangerous patch target");
    (0, vitest_1.expect)(output).toContain("- [MEDIUM] Schema mismatch");
});
(0, vitest_1.it)("does not render top risks section when no top risks exist", () => {
    const output = (0, renderDecisionSummary_js_1.renderDecisionSummary)({
        mode: "safe_to_apply",
        confidenceScore: 91,
        reasons: []
    });
    (0, vitest_1.expect)(output).not.toContain("Top Risks:");
});
(0, vitest_1.it)("renders explanation section in decision summary", () => {
    const output = (0, renderDecisionSummary_js_1.renderDecisionSummary)({
        mode: "preview_only",
        confidenceScore: 72,
        reasons: [
            {
                code: "PATCH_VALIDATION_WARNING",
                severity: "warning",
                message: "Patch should be reviewed."
            }
        ],
        topRisks: [
            {
                id: "risk-1",
                title: "Dangerous patch target",
                description: "Patch may touch risky file",
                severity: "high",
                score: 95,
                category: "patch",
                source: "warning"
            }
        ]
    });
    (0, vitest_1.expect)(output).toContain("Explanation:");
    (0, vitest_1.expect)(output).toContain("Decision was set to PREVIEW ONLY");
    (0, vitest_1.expect)(output).toContain("1 warning-level reason(s) affected the decision");
    (0, vitest_1.expect)(output).toContain("1 medium/high top risk(s) remain visible in the result");
});
//# sourceMappingURL=renderDecisionSummary.test.js.map