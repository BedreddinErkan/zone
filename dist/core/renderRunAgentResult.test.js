"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const renderRunAgentResult_js_1 = require("./renderRunAgentResult.js");
const buildDecisionAuditSnapshot_js_1 = require("./buildDecisionAuditSnapshot.js");
(0, vitest_1.describe)("renderRunAgentResult", () => {
    (0, vitest_1.it)("renders a safe_to_apply result in a readable product-style format", () => {
        const result = {
            task: "rename helper function",
            decision: {
                mode: "safe_to_apply",
                confidenceScore: 88
            },
            explanation: "SAFE TO APPLY: Task appears localized and low risk.",
            recommendation: "Safe to apply with standard review.",
            topRisks: []
        };
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)(result);
        (0, vitest_1.expect)(output).toContain("=== ZONE ===");
        (0, vitest_1.expect)(output).toContain("Task: rename helper function");
        (0, vitest_1.expect)(output).toContain("Decision: safe_to_apply");
        (0, vitest_1.expect)(output).toContain("Confidence: 88");
        (0, vitest_1.expect)(output).toContain("Explanation: SAFE TO APPLY: Task appears localized and low risk.");
        (0, vitest_1.expect)(output).toContain("Recommendation: Safe to apply with standard review.");
        (0, vitest_1.expect)(output).toContain("Top Risks:");
    });
    (0, vitest_1.it)("renders preview_only output for schema-related work", () => {
        const result = {
            task: "add schema migration for treatment timeline",
            decision: {
                mode: "preview_only",
                confidenceScore: 52
            },
            explanation: "PREVIEW ONLY: Task touches schema or a critical domain.",
            recommendation: "Inspect affected files and validate the change before applying.",
            topRisks: [
                {
                    title: "Sensitive change surface",
                    severity: "medium",
                    reason: "The task appears related to schema, auth, billing, or production."
                }
            ]
        };
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)(result);
        (0, vitest_1.expect)(output).toContain("Task: add schema migration for treatment timeline");
        (0, vitest_1.expect)(output).toContain("Decision: preview_only");
        (0, vitest_1.expect)(output).toContain("Confidence: 52");
        (0, vitest_1.expect)(output).toContain("Explanation: PREVIEW ONLY: Task touches schema or a critical domain.");
        (0, vitest_1.expect)(output).toContain("Recommendation: Inspect affected files and validate the change before applying.");
    });
    (0, vitest_1.it)("renders blocked output for high-risk work", () => {
        const result = {
            task: "delete user table from database",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            explanation: "BLOCKED: Risk score 75/100. High-risk signals detected (destructive, schema).",
            recommendation: "Do not auto-apply. Manual review is required before making changes.",
            topRisks: [
                {
                    title: "Potentially destructive change",
                    severity: "high",
                    reason: "Destructive keywords detected. Risk score=75."
                }
            ]
        };
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)(result);
        (0, vitest_1.expect)(output).toContain("Decision: blocked");
        (0, vitest_1.expect)(output).toContain("Top Risks:");
    });
    (0, vitest_1.it)("renders top risks section when top risks exist", () => {
        const enriched = {
            task: "delete user table from database",
            decision: {
                mode: "preview_only",
                confidenceScore: 32
            },
            explanation: "PREVIEW ONLY: Task includes destructive change signals.",
            recommendation: "Do not auto-apply. Review impact carefully before making changes.",
            topRisks: [
                {
                    title: "Potentially destructive change",
                    severity: "high",
                    reason: "The task contains delete/remove/drop-style language."
                }
            ]
        };
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)(enriched);
        (0, vitest_1.expect)(output).toContain("Top Risks:");
        (0, vitest_1.expect)(output).toContain("- [high] Potentially destructive change: The task contains delete/remove/drop-style language.");
    });
    (0, vitest_1.it)("renders risk breakdown when present", () => {
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)({
            task: "delete user table from database",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            risk: {
                score: 75,
                breakdown: {
                    destructive: 50,
                    schema: 25,
                    critical: 0,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            explanation: "BLOCKED: Risk score 75/100 (destructive + schema signals detected)",
            recommendation: "Do not auto-apply. Manual review is required before making changes.",
            topRisks: [
                {
                    title: "Potentially destructive change",
                    severity: "high",
                    reason: "Destructive keywords detected. Risk score=75."
                }
            ]
        });
        (0, vitest_1.expect)(output).toContain("=== RISK ===");
        (0, vitest_1.expect)(output).toContain("75/100");
        (0, vitest_1.expect)(output).toContain("=== RISK BREAKDOWN ===");
        (0, vitest_1.expect)(output).toContain("- destructive: 50");
        (0, vitest_1.expect)(output).toContain("- schema: 25");
        (0, vitest_1.expect)(output).toContain("- critical: 0");
        (0, vitest_1.expect)(output).toContain("- low-risk: 0");
        (0, vitest_1.expect)(output).toContain("- mass-scope: 0");
    });
    (0, vitest_1.it)("renders RISK section before CONFIDENCE section when both are present", () => {
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)({
            task: "delete user table from database",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            confidence: {
                score: 25,
                breakdown: {
                    base: 100,
                    destructivePenalty: -50,
                    schemaPenalty: -25,
                    criticalPenalty: 0,
                    massScopePenalty: 0,
                    lowRiskBonus: 0
                }
            },
            risk: {
                score: 75,
                breakdown: {
                    destructive: 50,
                    schema: 25,
                    critical: 0,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            explanation: "BLOCKED: Risk score 75/100 (destructive + schema signals detected)",
            recommendation: "Do not auto-apply. Manual review is required before making changes.",
            topRisks: []
        });
        const riskIndex = output.indexOf("=== RISK ===");
        const confidenceIndex = output.indexOf("=== CONFIDENCE BREAKDOWN ===");
        (0, vitest_1.expect)(riskIndex).toBeGreaterThan(-1);
        (0, vitest_1.expect)(confidenceIndex).toBeGreaterThan(-1);
        (0, vitest_1.expect)(riskIndex).toBeLessThan(confidenceIndex);
    });
    (0, vitest_1.it)("renders confidence breakdown when present", () => {
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)({
            task: "delete user table from database",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            confidence: {
                score: 25,
                breakdown: {
                    base: 100,
                    destructivePenalty: -50,
                    schemaPenalty: -25,
                    criticalPenalty: 0,
                    massScopePenalty: 0,
                    lowRiskBonus: 0
                }
            },
            risk: {
                score: 75,
                breakdown: {
                    destructive: 50,
                    schema: 25,
                    critical: 0,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            explanation: "BLOCKED: Risk score 75/100 (destructive + schema signals detected)",
            recommendation: "Do not auto-apply. Manual review is required before making changes.",
            topRisks: [
                {
                    title: "Potentially destructive change",
                    severity: "high",
                    reason: "Destructive keywords detected. Risk score=75."
                }
            ]
        });
        (0, vitest_1.expect)(output).toContain("=== CONFIDENCE BREAKDOWN ===");
        (0, vitest_1.expect)(output).toContain("- base: 100");
        (0, vitest_1.expect)(output).toContain("- destructive penalty: -50");
        (0, vitest_1.expect)(output).toContain("- schema penalty: -25");
        (0, vitest_1.expect)(output).toContain("- critical penalty: 0");
        (0, vitest_1.expect)(output).toContain("- mass-scope penalty: 0");
        (0, vitest_1.expect)(output).toContain("- low-risk bonus: 0");
    });
    (0, vitest_1.it)("renders reason codes when present", () => {
        const result = {
            task: "drop users table",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            risk: {
                score: 75,
                breakdown: {
                    destructive: 50,
                    schema: 25,
                    critical: 0,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            confidence: {
                score: 25,
                breakdown: {
                    base: 100,
                    destructivePenalty: -50,
                    schemaPenalty: -25,
                    criticalPenalty: 0,
                    massScopePenalty: 0,
                    lowRiskBonus: 0
                }
            },
            explanation: "BLOCKED: Risk score 75/100",
            recommendation: "Do not auto-apply. Manual review is required before making changes.",
            topRisks: [],
            reasonCodes: [
                "BLOCKED_DESTRUCTIVE_OPERATION",
                "BLOCKED_SCHEMA_RISK",
                "BLOCKED_HIGH_RISK_SCORE"
            ]
        };
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)(result);
        (0, vitest_1.expect)(output).toContain("Reason Codes:");
        (0, vitest_1.expect)(output).toContain("- BLOCKED_DESTRUCTIVE_OPERATION");
        (0, vitest_1.expect)(output).toContain("- BLOCKED_SCHEMA_RISK");
        (0, vitest_1.expect)(output).toContain("- BLOCKED_HIGH_RISK_SCORE");
    });
    (0, vitest_1.it)("renders reason details in verbose mode", () => {
        const result = {
            task: "drop users table",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            explanation: "BLOCKED: destructive and schema risk detected.",
            recommendation: "Do not auto-apply.",
            topRisks: [
                {
                    title: "Potentially destructive change",
                    severity: "high",
                    reason: "Task contains destructive keywords."
                }
            ],
            risk: {
                score: 75,
                breakdown: {
                    destructive: 50,
                    schema: 25,
                    critical: 0,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            confidence: {
                score: 25,
                breakdown: {
                    base: 100,
                    destructivePenalty: -50,
                    schemaPenalty: -25,
                    criticalPenalty: 0,
                    massScopePenalty: 0,
                    lowRiskBonus: 0
                }
            },
            reasonCodes: [
                "BLOCKED_DESTRUCTIVE_OPERATION",
                "BLOCKED_SCHEMA_RISK",
                "BLOCKED_HIGH_RISK_SCORE"
            ]
        };
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)(result, { verbose: true });
        (0, vitest_1.expect)(output).toContain("Reason Codes:");
        (0, vitest_1.expect)(output).toContain("Reason Details:");
        (0, vitest_1.expect)(output).toContain("code: BLOCKED_DESTRUCTIVE_OPERATION");
        (0, vitest_1.expect)(output).toContain("summary:");
    });
    (0, vitest_1.it)("does not fail when reasonCodes are missing", () => {
        const result = {
            task: "drop users table",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            explanation: "BLOCKED: destructive and schema risk detected.",
            recommendation: "Do not auto-apply.",
            topRisks: [
                {
                    title: "Potentially destructive change",
                    severity: "high",
                    reason: "Task contains destructive keywords."
                }
            ],
            risk: {
                score: 75,
                breakdown: {
                    destructive: 50,
                    schema: 25,
                    critical: 0,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            confidence: {
                score: 25,
                breakdown: {
                    base: 100,
                    destructivePenalty: -50,
                    schemaPenalty: -25,
                    criticalPenalty: 0,
                    massScopePenalty: 0,
                    lowRiskBonus: 0
                }
            }
        };
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)(result);
        (0, vitest_1.expect)(output).not.toContain("Reason Codes:");
        (0, vitest_1.expect)(output).not.toContain("Reason Details:");
    });
    (0, vitest_1.it)("renders audit summary in verbose mode when auditSnapshot is provided", () => {
        const auditSnapshot = (0, buildDecisionAuditSnapshot_js_1.buildDecisionAuditSnapshot)({
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            risk: {
                score: 75,
                breakdown: {
                    destructive: 50,
                    schema: 25,
                    critical: 0,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            topRisks: [
                {
                    title: "Potentially destructive change",
                    severity: "high",
                    reason: "Task contains destructive keywords."
                }
            ],
            reasonCodes: [
                "BLOCKED_DESTRUCTIVE_OPERATION",
                "BLOCKED_SCHEMA_RISK",
                "BLOCKED_HIGH_RISK_SCORE"
            ],
            trace: {
                signals: ["destructive", "schema"],
                normalizedSignals: [
                    {
                        type: "destructive",
                        severity: "high",
                        confidenceImpact: -50,
                        label: "Potentially destructive change"
                    },
                    {
                        type: "schema",
                        severity: "medium",
                        confidenceImpact: -25,
                        label: "Schema-sensitive change"
                    }
                ],
                riskScore: 75,
                confidenceScore: 25,
                appliedPenalties: [
                    {
                        type: "destructive",
                        impact: -50
                    },
                    {
                        type: "schema",
                        impact: -25
                    }
                ],
                decisionPath: [
                    "Detected destructive signal",
                    "Detected schema signal",
                    "Mapped to BLOCKED mode"
                ],
                decisionFactors: {
                    riskThreshold: 71,
                    triggeredBy: ["riskScore"]
                },
                confidenceFormula: "100 - 50 (destructive) - 25 (schema) = 25",
                reasonMapping: []
            }
        });
        const result = {
            task: "drop users table",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            explanation: "BLOCKED: destructive and schema risk detected.",
            recommendation: "Do not auto-apply.",
            topRisks: [
                {
                    title: "Potentially destructive change",
                    severity: "high",
                    reason: "Task contains destructive keywords."
                }
            ],
            risk: {
                score: 75,
                breakdown: {
                    destructive: 50,
                    schema: 25,
                    critical: 0,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            confidence: {
                score: 25,
                breakdown: {
                    base: 100,
                    destructivePenalty: -50,
                    schemaPenalty: -25,
                    criticalPenalty: 0,
                    massScopePenalty: 0,
                    lowRiskBonus: 0
                }
            },
            reasonCodes: [
                "BLOCKED_DESTRUCTIVE_OPERATION",
                "BLOCKED_SCHEMA_RISK",
                "BLOCKED_HIGH_RISK_SCORE"
            ],
            auditSnapshot
        };
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)(result, { verbose: true });
        (0, vitest_1.expect)(output).toContain("Audit Summary:");
        (0, vitest_1.expect)(output).toContain("- triggered by: riskScore");
        (0, vitest_1.expect)(output).toContain("- confidence formula: 100 - 50 (destructive) - 25 (schema) = 25");
        (0, vitest_1.expect)(output).toContain("- audit reasons:");
        (0, vitest_1.expect)(output).toContain("  -");
    });
    (0, vitest_1.it)("does not render audit summary when verbose is false", () => {
        const auditSnapshot = (0, buildDecisionAuditSnapshot_js_1.buildDecisionAuditSnapshot)({
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            risk: {
                score: 75,
                breakdown: {
                    destructive: 50,
                    schema: 25,
                    critical: 0,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            topRisks: [],
            reasonCodes: ["BLOCKED_DESTRUCTIVE_OPERATION"],
            trace: {
                signals: ["destructive"],
                normalizedSignals: [
                    {
                        type: "destructive",
                        severity: "high",
                        confidenceImpact: -50,
                        label: "Potentially destructive change"
                    }
                ],
                riskScore: 75,
                confidenceScore: 25,
                appliedPenalties: [
                    {
                        type: "destructive",
                        impact: -50
                    }
                ],
                decisionPath: ["Detected destructive signal", "Mapped to BLOCKED mode"],
                decisionFactors: {
                    riskThreshold: 71,
                    triggeredBy: ["riskScore"]
                },
                confidenceFormula: "100 - 50 (destructive) = 50",
                reasonMapping: []
            }
        });
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)({
            task: "drop users table",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            explanation: "BLOCKED: destructive signal detected.",
            recommendation: "Do not auto-apply.",
            topRisks: [],
            auditSnapshot
        }, { verbose: false });
        (0, vitest_1.expect)(output).not.toContain("Audit Summary:");
    });
    (0, vitest_1.it)("does not render audit summary when auditSnapshot is missing", () => {
        const result = {
            task: "drop users table",
            decision: {
                mode: "blocked",
                confidenceScore: 25
            },
            explanation: "BLOCKED: destructive and schema risk detected.",
            recommendation: "Do not auto-apply.",
            topRisks: []
        };
        const output = (0, renderRunAgentResult_js_1.renderRunAgentResult)(result, { verbose: true });
        (0, vitest_1.expect)(output).not.toContain("Audit Summary:");
    });
});
//# sourceMappingURL=renderRunAgentResult.test.js.map