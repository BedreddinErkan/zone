"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildDecisionTrace_js_1 = require("./buildDecisionTrace.js");
// ─── Helpers ────────────────────────────────────────────────────────────────
const emptyBreakdown = {
    base: 100,
    destructivePenalty: 0,
    schemaPenalty: 0,
    criticalPenalty: 0,
    massScopePenalty: 0,
    lowRiskBonus: 0
};
// ─── Core Fields ────────────────────────────────────────────────────────────
(0, vitest_1.describe)("buildDecisionTrace – core fields", () => {
    (0, vitest_1.it)("copies raw signals as-is", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "mass_scope"],
            riskScore: 75,
            confidenceScore: 25,
            mode: "blocked",
            confidenceBreakdown: {
                ...emptyBreakdown,
                destructivePenalty: -50,
                massScopePenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.signals).toEqual(["destructive", "mass_scope"]);
    });
    (0, vitest_1.it)("copies score fields exactly", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["schema"],
            riskScore: 25,
            confidenceScore: 75,
            mode: "preview_only",
            confidenceBreakdown: {
                ...emptyBreakdown,
                schemaPenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.riskScore).toBe(25);
        (0, vitest_1.expect)(trace.confidenceScore).toBe(75);
    });
});
// ─── Normalized Signals ─────────────────────────────────────────────────────
(0, vitest_1.describe)("buildDecisionTrace – normalizedSignals", () => {
    (0, vitest_1.it)("builds normalizedSignals from raw signals", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "mass_scope"],
            riskScore: 75,
            confidenceScore: 25,
            mode: "blocked",
            confidenceBreakdown: {
                ...emptyBreakdown,
                destructivePenalty: -50,
                massScopePenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.normalizedSignals).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                type: "destructive",
                severity: "high",
                confidenceImpact: -50,
                label: "Potentially destructive change"
            }),
            vitest_1.expect.objectContaining({
                type: "mass_scope",
                severity: "high",
                confidenceImpact: -25,
                label: "Mass-scope operation"
            })
        ]));
    });
    (0, vitest_1.it)("normalizes schema signal correctly", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["schema"],
            riskScore: 25,
            confidenceScore: 75,
            mode: "preview_only",
            confidenceBreakdown: {
                ...emptyBreakdown,
                schemaPenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.normalizedSignals).toEqual(vitest_1.expect.arrayContaining([
            vitest_1.expect.objectContaining({
                type: "schema",
                severity: "medium"
            })
        ]));
    });
    (0, vitest_1.it)("returns empty normalizedSignals for empty signals array", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: [],
            riskScore: 0,
            confidenceScore: 100,
            mode: "safe_to_apply",
            confidenceBreakdown: emptyBreakdown
        });
        (0, vitest_1.expect)(trace.normalizedSignals).toEqual([]);
    });
});
// ─── Applied Penalties ───────────────────────────────────────────────────────
(0, vitest_1.describe)("buildDecisionTrace – appliedPenalties", () => {
    (0, vitest_1.it)("includes all active penalties", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "schema", "mass_scope"],
            riskScore: 100,
            confidenceScore: 0,
            mode: "blocked",
            confidenceBreakdown: {
                ...emptyBreakdown,
                destructivePenalty: -50,
                schemaPenalty: -25,
                massScopePenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.appliedPenalties).toEqual([
            { type: "destructive", impact: -50 },
            { type: "schema", impact: -25 },
            { type: "mass_scope", impact: -25 }
        ]);
    });
    (0, vitest_1.it)("includes critical_domain penalty when present", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["critical_domain"],
            riskScore: 40,
            confidenceScore: 60,
            mode: "preview_only",
            confidenceBreakdown: {
                ...emptyBreakdown,
                criticalPenalty: -20
            }
        });
        (0, vitest_1.expect)(trace.appliedPenalties).toEqual([
            { type: "critical_domain", impact: -20 }
        ]);
    });
    (0, vitest_1.it)("returns empty appliedPenalties when no penalties exist", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["low_risk"],
            riskScore: 0,
            confidenceScore: 100,
            mode: "safe_to_apply",
            confidenceBreakdown: {
                ...emptyBreakdown,
                lowRiskBonus: 10
            }
        });
        (0, vitest_1.expect)(trace.appliedPenalties).toEqual([]);
    });
    (0, vitest_1.it)("skips zero-value penalties", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive"],
            riskScore: 50,
            confidenceScore: 50,
            mode: "blocked",
            confidenceBreakdown: {
                ...emptyBreakdown,
                destructivePenalty: -50,
                schemaPenalty: 0
            }
        });
        const types = trace.appliedPenalties.map((p) => p.type);
        (0, vitest_1.expect)(types).not.toContain("schema");
        (0, vitest_1.expect)(types).toContain("destructive");
    });
});
// ─── Decision Path ───────────────────────────────────────────────────────────
(0, vitest_1.describe)("buildDecisionTrace – decisionPath", () => {
    (0, vitest_1.it)("starts with detected signals in order", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "mass_scope"],
            riskScore: 75,
            confidenceScore: 25,
            mode: "blocked",
            confidenceBreakdown: {
                ...emptyBreakdown,
                destructivePenalty: -50,
                massScopePenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.decisionPath[0]).toBe("Detected destructive signal");
        (0, vitest_1.expect)(trace.decisionPath[1]).toBe("Detected mass_scope signal");
    });
    (0, vitest_1.it)("includes applied penalties after signals", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "schema"],
            riskScore: 75,
            confidenceScore: 25,
            mode: "blocked",
            confidenceBreakdown: {
                ...emptyBreakdown,
                destructivePenalty: -50,
                schemaPenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.decisionPath).toContain("Applied destructive penalty: -50");
        (0, vitest_1.expect)(trace.decisionPath).toContain("Applied schema penalty: -25");
    });
    (0, vitest_1.it)("ends with risk score then mode", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["low_risk"],
            riskScore: 0,
            confidenceScore: 100,
            mode: "safe_to_apply",
            confidenceBreakdown: {
                ...emptyBreakdown,
                lowRiskBonus: 10
            }
        });
        (0, vitest_1.expect)(trace.decisionPath.at(-2)).toBe("Total risk score: 0");
        (0, vitest_1.expect)(trace.decisionPath.at(-1)).toBe("Mapped to SAFE_TO_APPLY mode");
    });
    (0, vitest_1.it)("produces correct full path for blocked decision", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "mass_scope"],
            riskScore: 75,
            confidenceScore: 25,
            mode: "blocked",
            confidenceBreakdown: {
                ...emptyBreakdown,
                destructivePenalty: -50,
                massScopePenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.decisionPath).toEqual([
            "Detected destructive signal",
            "Detected mass_scope signal",
            "Applied destructive penalty: -50",
            "Applied mass_scope penalty: -25",
            "Total risk score: 75",
            "Mapped to BLOCKED mode"
        ]);
    });
    (0, vitest_1.it)("produces correct full path for preview_only decision", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["schema"],
            riskScore: 25,
            confidenceScore: 75,
            mode: "preview_only",
            confidenceBreakdown: {
                ...emptyBreakdown,
                schemaPenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.decisionPath).toEqual([
            "Detected schema signal",
            "Applied schema penalty: -25",
            "Total risk score: 25",
            "Mapped to PREVIEW_ONLY mode"
        ]);
    });
    (0, vitest_1.it)("produces correct full path for safe_to_apply decision", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["low_risk"],
            riskScore: 0,
            confidenceScore: 100,
            mode: "safe_to_apply",
            confidenceBreakdown: {
                ...emptyBreakdown,
                lowRiskBonus: 10
            }
        });
        (0, vitest_1.expect)(trace.decisionPath).toEqual([
            "Detected low_risk signal",
            "Total risk score: 0",
            "Mapped to SAFE_TO_APPLY mode"
        ]);
    });
    (0, vitest_1.it)("skips Applied steps entirely when no penalties", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["low_risk"],
            riskScore: 0,
            confidenceScore: 100,
            mode: "safe_to_apply",
            confidenceBreakdown: emptyBreakdown
        });
        const hasApplied = trace.decisionPath.some((step) => step.startsWith("Applied"));
        (0, vitest_1.expect)(hasApplied).toBe(false);
    });
    (0, vitest_1.it)("handles empty signals array gracefully", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: [],
            riskScore: 0,
            confidenceScore: 100,
            mode: "safe_to_apply",
            confidenceBreakdown: emptyBreakdown
        });
        (0, vitest_1.expect)(trace.decisionPath).toEqual([
            "Total risk score: 0",
            "Mapped to SAFE_TO_APPLY mode"
        ]);
    });
});
(0, vitest_1.describe)("buildDecisionTrace – decisionFactors", () => {
    (0, vitest_1.it)("sets riskThreshold 71 for blocked mode", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive"],
            riskScore: 75,
            confidenceScore: 25,
            mode: "blocked",
            confidenceBreakdown: emptyBreakdown
        });
        (0, vitest_1.expect)(trace.decisionFactors.riskThreshold).toBe(71);
    });
    (0, vitest_1.it)("sets riskThreshold 31 for preview_only mode", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["schema"],
            riskScore: 35,
            confidenceScore: 65,
            mode: "preview_only",
            confidenceBreakdown: emptyBreakdown
        });
        (0, vitest_1.expect)(trace.decisionFactors.riskThreshold).toBe(31);
    });
    (0, vitest_1.it)("sets riskThreshold 0 for safe_to_apply mode", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["low_risk"],
            riskScore: 0,
            confidenceScore: 100,
            mode: "safe_to_apply",
            confidenceBreakdown: emptyBreakdown
        });
        (0, vitest_1.expect)(trace.decisionFactors.riskThreshold).toBe(0);
    });
    (0, vitest_1.it)("triggeredBy includes riskScore when score >= 71", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "schema"],
            riskScore: 75,
            confidenceScore: 25,
            mode: "blocked",
            confidenceBreakdown: emptyBreakdown
        });
        (0, vitest_1.expect)(trace.decisionFactors.triggeredBy).toEqual(["riskScore"]);
    });
    (0, vitest_1.it)("triggeredBy includes signal names when score < 71 but signals force preview", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["schema", "mass_scope"],
            riskScore: 50,
            confidenceScore: 50,
            mode: "preview_only",
            confidenceBreakdown: emptyBreakdown
        });
        (0, vitest_1.expect)(trace.decisionFactors.triggeredBy).toContain("schema");
        (0, vitest_1.expect)(trace.decisionFactors.triggeredBy).toContain("mass_scope");
        (0, vitest_1.expect)(trace.decisionFactors.triggeredBy).not.toContain("riskScore");
    });
    (0, vitest_1.it)("triggeredBy is empty for safe_to_apply", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["low_risk"],
            riskScore: 0,
            confidenceScore: 100,
            mode: "safe_to_apply",
            confidenceBreakdown: emptyBreakdown
        });
        (0, vitest_1.expect)(trace.decisionFactors.triggeredBy).toEqual([]);
    });
});
(0, vitest_1.describe)("buildDecisionTrace – confidenceFormula", () => {
    (0, vitest_1.it)("shows only base when no penalties or bonuses", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: [],
            riskScore: 0,
            confidenceScore: 100,
            mode: "safe_to_apply",
            confidenceBreakdown: emptyBreakdown
        });
        (0, vitest_1.expect)(trace.confidenceFormula).toBe("100 = 100");
    });
    (0, vitest_1.it)("shows single destructive penalty", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive"],
            riskScore: 50,
            confidenceScore: 50,
            mode: "preview_only",
            confidenceBreakdown: {
                ...emptyBreakdown,
                destructivePenalty: -50
            }
        });
        (0, vitest_1.expect)(trace.confidenceFormula).toBe("100 - 50 (destructive) = 50");
    });
    (0, vitest_1.it)("shows multiple penalties combined", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "schema"],
            riskScore: 75,
            confidenceScore: 25,
            mode: "blocked",
            confidenceBreakdown: {
                ...emptyBreakdown,
                destructivePenalty: -50,
                schemaPenalty: -25
            }
        });
        (0, vitest_1.expect)(trace.confidenceFormula).toBe("100 - 50 (destructive) - 25 (schema) = 25");
    });
    (0, vitest_1.it)("shows low-risk bonus with plus sign", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["low_risk"],
            riskScore: 0,
            confidenceScore: 110,
            mode: "safe_to_apply",
            confidenceBreakdown: {
                ...emptyBreakdown,
                lowRiskBonus: 10
            }
        });
        (0, vitest_1.expect)(trace.confidenceFormula).toBe("100 + 10 (low-risk bonus) = 110");
    });
    (0, vitest_1.it)("shows all penalty types in correct order", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "schema", "critical_domain", "mass_scope"],
            riskScore: 100,
            confidenceScore: 0,
            mode: "blocked",
            confidenceBreakdown: {
                base: 100,
                destructivePenalty: -40,
                schemaPenalty: -20,
                criticalPenalty: -20,
                massScopePenalty: -20,
                lowRiskBonus: 0
            }
        });
        (0, vitest_1.expect)(trace.confidenceFormula).toBe("100 - 40 (destructive) - 20 (schema) - 20 (critical) - 20 (mass-scope) = 0");
    });
    (0, vitest_1.it)("result equals base plus all values summed", () => {
        const breakdown = {
            base: 100,
            destructivePenalty: -50,
            schemaPenalty: -25,
            criticalPenalty: -10,
            massScopePenalty: -5,
            lowRiskBonus: 0
        };
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["destructive", "schema", "critical_domain", "mass_scope"],
            riskScore: 90,
            confidenceScore: 10,
            mode: "blocked",
            confidenceBreakdown: breakdown
        });
        const expectedResult = breakdown.base +
            breakdown.destructivePenalty +
            breakdown.schemaPenalty +
            breakdown.criticalPenalty +
            breakdown.massScopePenalty +
            breakdown.lowRiskBonus;
        (0, vitest_1.expect)(trace.confidenceFormula).toContain(`= ${expectedResult}`);
    });
    (0, vitest_1.it)("includes reasonMapping when reason details are provided", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: ["schema"],
            riskScore: 40,
            confidenceScore: 75,
            confidenceBreakdown: {
                base: 100,
                destructivePenalty: 0,
                schemaPenalty: -25,
                criticalPenalty: 0,
                massScopePenalty: 0,
                lowRiskBonus: 0
            },
            mode: "preview_only",
            reasonDetails: [
                {
                    code: "PREVIEW_SCHEMA_RISK",
                    severity: "warning",
                    category: "risk",
                    message: "Schema-sensitive changes require preview."
                }
            ]
        });
        (0, vitest_1.expect)(trace.reasonMapping).toEqual([
            {
                code: "PREVIEW_SCHEMA_RISK",
                severity: "warning",
                category: "risk",
                message: "Schema-sensitive changes require preview."
            }
        ]);
    });
    (0, vitest_1.it)("returns empty reasonMapping when reason details are omitted", () => {
        const trace = (0, buildDecisionTrace_js_1.buildDecisionTrace)({
            signals: [],
            riskScore: 0,
            confidenceScore: 100,
            confidenceBreakdown: {
                base: 100,
                destructivePenalty: 0,
                schemaPenalty: 0,
                criticalPenalty: 0,
                massScopePenalty: 0,
                lowRiskBonus: 0
            },
            mode: "safe_to_apply"
        });
        (0, vitest_1.expect)(trace.reasonMapping).toEqual([]);
    });
});
//# sourceMappingURL=buildDecisionTrace.test.js.map