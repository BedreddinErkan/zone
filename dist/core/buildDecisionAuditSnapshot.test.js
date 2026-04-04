"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildDecisionAuditSnapshot_js_1 = require("./buildDecisionAuditSnapshot.js");
(0, vitest_1.describe)("buildDecisionAuditSnapshot", () => {
    (0, vitest_1.it)("builds a deterministic audit snapshot from runAgent-style output", () => {
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
            explanation: "BLOCKED: Risk score 75/100 (destructive + schema signals detected)",
            recommendation: "Do not auto-apply. Manual review is required before making changes.",
            topRisks: [
                {
                    title: "Potentially destructive change",
                    severity: "high",
                    reason: "Task contains destructive keywords that may cause irreversible data loss."
                },
                {
                    title: "Schema-sensitive change",
                    severity: "medium",
                    reason: "Task may impact schema stability."
                }
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
            },
            reasonCodes: [
                "BLOCKED_DESTRUCTIVE_OPERATION",
                "BLOCKED_SCHEMA_RISK",
                "BLOCKED_HIGH_RISK_SCORE"
            ]
        };
        const snapshot = (0, buildDecisionAuditSnapshot_js_1.buildDecisionAuditSnapshot)(result);
        (0, vitest_1.expect)(snapshot.mode).toBe("blocked");
        (0, vitest_1.expect)(snapshot.confidenceScore).toBe(25);
        (0, vitest_1.expect)(snapshot.riskScore).toBe(75);
        (0, vitest_1.expect)(snapshot.reasonCodes).toEqual([
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_SCHEMA_RISK",
            "BLOCKED_HIGH_RISK_SCORE"
        ]);
        (0, vitest_1.expect)(snapshot.reasonDetails).toHaveLength(3);
        (0, vitest_1.expect)(snapshot.reasonDetails[0]).toEqual(vitest_1.expect.objectContaining({
            code: vitest_1.expect.any(String),
            label: vitest_1.expect.any(String),
            summary: vitest_1.expect.any(String),
            severity: vitest_1.expect.any(String),
            category: vitest_1.expect.any(String)
        }));
        (0, vitest_1.expect)(snapshot.triggeredBy).toEqual(["riskScore"]);
        (0, vitest_1.expect)(snapshot.confidenceFormula).toBe("100 - 50 (destructive) - 25 (schema) = 25");
        (0, vitest_1.expect)(snapshot.topRiskSummaries).toEqual([
            "[high] Potentially destructive change",
            "[medium] Schema-sensitive change"
        ]);
    });
    (0, vitest_1.it)("returns empty derived arrays when reasonCodes and topRisks are absent or empty", () => {
        const result = {
            decision: {
                mode: "safe_to_apply",
                confidenceScore: 91
            },
            risk: {
                score: 10,
                breakdown: {
                    destructive: 0,
                    schema: 0,
                    critical: 0,
                    lowRisk: 10,
                    massScope: 0
                }
            },
            topRisks: [],
            trace: {
                signals: [],
                normalizedSignals: [],
                riskScore: 10,
                confidenceScore: 91,
                appliedPenalties: [],
                decisionPath: ["Low-risk localized task"],
                decisionFactors: {
                    riskThreshold: 71,
                    triggeredBy: []
                },
                confidenceFormula: "100 + 0 = 100",
                reasonMapping: []
            },
            reasonCodes: []
        };
        const snapshot = (0, buildDecisionAuditSnapshot_js_1.buildDecisionAuditSnapshot)(result);
        (0, vitest_1.expect)(snapshot.mode).toBe("safe_to_apply");
        (0, vitest_1.expect)(snapshot.confidenceScore).toBe(91);
        (0, vitest_1.expect)(snapshot.riskScore).toBe(10);
        (0, vitest_1.expect)(snapshot.reasonCodes).toEqual([]);
        (0, vitest_1.expect)(snapshot.reasonDetails).toEqual([]);
        (0, vitest_1.expect)(snapshot.triggeredBy).toEqual([]);
        (0, vitest_1.expect)(snapshot.confidenceFormula).toBe("100 + 0 = 100");
        (0, vitest_1.expect)(snapshot.topRiskSummaries).toEqual([]);
    });
    (0, vitest_1.it)("gracefully falls back when trace is missing", () => {
        const result = {
            decision: {
                mode: "preview_only",
                confidenceScore: 55,
            },
            risk: {
                score: 45,
                breakdown: {
                    destructive: 0,
                    schema: 25,
                    critical: 20,
                    lowRisk: 0,
                    massScope: 0
                }
            },
            topRisks: [
                {
                    title: "Critical area change",
                    severity: "medium",
                    reason: "Touches a critical domain."
                }
            ],
            reasonCodes: ["PREVIEW_CRITICAL_SIGNAL"]
        };
        const snapshot = (0, buildDecisionAuditSnapshot_js_1.buildDecisionAuditSnapshot)(result);
        (0, vitest_1.expect)(snapshot.mode).toBe("preview_only");
        (0, vitest_1.expect)(snapshot.confidenceScore).toBe(55);
        (0, vitest_1.expect)(snapshot.riskScore).toBe(45);
        (0, vitest_1.expect)(snapshot.reasonCodes).toEqual(["PREVIEW_CRITICAL_SIGNAL"]);
        (0, vitest_1.expect)(snapshot.reasonDetails).toHaveLength(1);
        (0, vitest_1.expect)(snapshot.triggeredBy).toEqual([]);
        (0, vitest_1.expect)(snapshot.confidenceFormula).toBe("");
        (0, vitest_1.expect)(snapshot.topRiskSummaries).toEqual([
            "[medium] Critical area change"
        ]);
    });
});
//# sourceMappingURL=buildDecisionAuditSnapshot.test.js.map