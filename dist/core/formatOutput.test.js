"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const formatOutput_js_1 = require("./formatOutput.js");
const mockResult = {
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
    explanation: "BLOCKED: Risk score 75/100 (destructive + schema signals detected)\nPrimary cause: destructive operation\nConfidence impact: destructive penalty: -50, schema penalty: -25",
    recommendation: "Do not auto-apply. Manual review is required before making changes.",
    topRisks: [
        {
            title: "Potentially destructive change",
            severity: "high",
            reason: "Task contains destructive keywords that may cause irreversible data loss."
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
        decisionPath: [],
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
(0, vitest_1.describe)("formatOutput - text", () => {
    (0, vitest_1.it)("returns CLI-style string containing ZONE header", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "text");
        (0, vitest_1.expect)(output).toContain("=== ZONE ===");
    });
    (0, vitest_1.it)("includes task and decision in output", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "text");
        (0, vitest_1.expect)(output).toContain("Task: drop users table");
        (0, vitest_1.expect)(output).toContain("Decision: blocked");
    });
    (0, vitest_1.it)("returns a non-empty string", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "text");
        (0, vitest_1.expect)(typeof output).toBe("string");
        (0, vitest_1.expect)(output.length).toBeGreaterThan(0);
    });
});
(0, vitest_1.describe)("formatOutput - json", () => {
    (0, vitest_1.it)("returns a valid JSON string that can be parsed", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json");
        (0, vitest_1.expect)(() => JSON.parse(output)).not.toThrow();
    });
    (0, vitest_1.it)("preserves top-level RunAgentResult fields", () => {
        const parsed = JSON.parse((0, formatOutput_js_1.formatOutput)(mockResult, "json"));
        (0, vitest_1.expect)(parsed.task).toBe("drop users table");
        (0, vitest_1.expect)(parsed.explanation).toContain("BLOCKED");
        (0, vitest_1.expect)(parsed.recommendation).toBe("Do not auto-apply. Manual review is required before making changes.");
    });
    (0, vitest_1.it)("preserves decision shape", () => {
        const parsed = JSON.parse((0, formatOutput_js_1.formatOutput)(mockResult, "json"));
        (0, vitest_1.expect)(parsed.decision.mode).toBe("blocked");
        (0, vitest_1.expect)(parsed.decision.confidenceScore).toBe(25);
    });
    (0, vitest_1.it)("preserves risk breakdown shape", () => {
        const parsed = JSON.parse((0, formatOutput_js_1.formatOutput)(mockResult, "json"));
        (0, vitest_1.expect)(parsed.risk.score).toBe(75);
        (0, vitest_1.expect)(parsed.risk.breakdown.destructive).toBe(50);
        (0, vitest_1.expect)(parsed.risk.breakdown.schema).toBe(25);
        (0, vitest_1.expect)(parsed.risk.breakdown.critical).toBe(0);
        (0, vitest_1.expect)(parsed.risk.breakdown.lowRisk).toBe(0);
        (0, vitest_1.expect)(parsed.risk.breakdown.massScope).toBe(0);
    });
    (0, vitest_1.it)("preserves confidence breakdown shape", () => {
        const parsed = JSON.parse((0, formatOutput_js_1.formatOutput)(mockResult, "json"));
        (0, vitest_1.expect)(parsed.confidence.score).toBe(25);
        (0, vitest_1.expect)(parsed.confidence.breakdown.base).toBe(100);
        (0, vitest_1.expect)(parsed.confidence.breakdown.destructivePenalty).toBe(-50);
        (0, vitest_1.expect)(parsed.confidence.breakdown.schemaPenalty).toBe(-25);
        (0, vitest_1.expect)(parsed.confidence.breakdown.massScopePenalty).toBe(0);
    });
    (0, vitest_1.it)("preserves topRisks array with all fields", () => {
        const parsed = JSON.parse((0, formatOutput_js_1.formatOutput)(mockResult, "json"));
        (0, vitest_1.expect)(parsed.topRisks).toHaveLength(1);
        (0, vitest_1.expect)(parsed.topRisks[0].title).toBe("Potentially destructive change");
        (0, vitest_1.expect)(parsed.topRisks[0].severity).toBe("high");
        (0, vitest_1.expect)(parsed.topRisks[0].reason).toContain("irreversible");
    });
    (0, vitest_1.it)("preserves reasonCodes array", () => {
        const parsed = JSON.parse((0, formatOutput_js_1.formatOutput)(mockResult, "json", { verbose: true }));
        (0, vitest_1.expect)(parsed.reasonCodes).toEqual([
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_SCHEMA_RISK",
            "BLOCKED_HIGH_RISK_SCORE"
        ]);
    });
});
const mockResultWithPath = {
    ...mockResult,
    trace: {
        ...mockResult.trace,
        decisionPath: [
            "Detected destructive signal",
            "Applied destructive penalty: -50",
            "Total risk score: 75",
            "Mapped to BLOCKED mode"
        ]
    }
};
(0, vitest_1.describe)("formatOutput - trace options", () => {
    (0, vitest_1.it)("does not include trace in output by default", () => {
        const text = (0, formatOutput_js_1.formatOutput)(mockResult, "text");
        (0, vitest_1.expect)(text).not.toContain("Decision Trace");
        const json = (0, formatOutput_js_1.formatOutput)(mockResult, "json");
        const parsed = JSON.parse(json);
        (0, vitest_1.expect)(parsed.trace).toBeUndefined();
    });
    (0, vitest_1.it)("includes decisionPath in text output when showTrace is true", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResultWithPath, "text", { showTrace: true });
        (0, vitest_1.expect)(output).toContain("--- Decision Trace ---");
        (0, vitest_1.expect)(output).toContain("→ Detected destructive signal");
        (0, vitest_1.expect)(output).toContain("→ Mapped to BLOCKED mode");
    });
    (0, vitest_1.it)("includes confidenceFormula in text output when showTrace is true", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResultWithPath, "text", { showTrace: true });
        (0, vitest_1.expect)(output).toContain("Formula:");
        (0, vitest_1.expect)(output).toContain("100 - 50 (destructive) - 25 (schema) = 25");
    });
    (0, vitest_1.it)("includes trace in JSON output when showTrace is true", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json", { showTrace: true });
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.trace).toBeDefined();
        (0, vitest_1.expect)(Array.isArray(parsed.trace.decisionPath)).toBe(true);
        (0, vitest_1.expect)(parsed.trace.confidenceFormula).toBeDefined();
    });
    (0, vitest_1.it)("verbose includes trace in JSON output", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json", { verbose: true });
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.trace).toBeDefined();
        (0, vitest_1.expect)(parsed.trace.decisionFactors).toBeDefined();
    });
    (0, vitest_1.it)("text output without trace flag is unchanged", () => {
        const withoutTrace = (0, formatOutput_js_1.formatOutput)(mockResult, "text");
        const withTrace = (0, formatOutput_js_1.formatOutput)(mockResult, "text", { showTrace: false });
        (0, vitest_1.expect)(withoutTrace).toBe(withTrace);
        (0, vitest_1.expect)(withoutTrace).toContain("=== ZONE ===");
    });
    (0, vitest_1.it)("does not include reasonDetails in JSON output by default", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json");
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.reasonCodes).toEqual([
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_SCHEMA_RISK",
            "BLOCKED_HIGH_RISK_SCORE"
        ]);
        (0, vitest_1.expect)(parsed.reasonDetails).toBeUndefined();
    });
    (0, vitest_1.it)("includes reasonDetails in JSON output when verbose is true", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json", { verbose: true });
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.reasonDetails).toBeDefined();
        (0, vitest_1.expect)(Array.isArray(parsed.reasonDetails)).toBe(true);
        (0, vitest_1.expect)(parsed.reasonDetails).toHaveLength(3);
        (0, vitest_1.expect)(parsed.reasonDetails[0]).toHaveProperty("code");
        (0, vitest_1.expect)(parsed.reasonDetails[0]).toHaveProperty("label");
        (0, vitest_1.expect)(parsed.reasonDetails[0]).toHaveProperty("summary");
        (0, vitest_1.expect)(parsed.reasonDetails[0]).toHaveProperty("severity");
        (0, vitest_1.expect)(parsed.reasonDetails[0]).toHaveProperty("category");
    });
    (0, vitest_1.it)("includes trace but omits reasonDetails in JSON output when showTrace is true", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json", { showTrace: true });
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.trace).toBeDefined();
        (0, vitest_1.expect)(parsed.reasonDetails).toBeUndefined();
        (0, vitest_1.expect)(parsed.auditSnapshot).toBeUndefined();
    });
    (0, vitest_1.it)("includes verbose reason details in text output when verbose is true", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "text", { verbose: true });
        (0, vitest_1.expect)(output).toContain("Reason Codes:");
        (0, vitest_1.expect)(output).toContain("Reason Details:");
        (0, vitest_1.expect)(output).toContain("code: BLOCKED_DESTRUCTIVE_OPERATION");
        (0, vitest_1.expect)(output).toContain("summary:");
    });
    (0, vitest_1.it)("keeps reasonCodes but omits reasonDetails in default JSON output", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json");
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.reasonCodes).toEqual([
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_SCHEMA_RISK",
            "BLOCKED_HIGH_RISK_SCORE"
        ]);
        (0, vitest_1.expect)(parsed.reasonDetails).toBeUndefined();
    });
    (0, vitest_1.it)("includes structured reasonDetails in verbose JSON output", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json", { verbose: true });
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.reasonDetails).toBeDefined();
        (0, vitest_1.expect)(Array.isArray(parsed.reasonDetails)).toBe(true);
        (0, vitest_1.expect)(parsed.reasonDetails).toHaveLength(3);
        (0, vitest_1.expect)(parsed.reasonDetails[0]).toEqual(vitest_1.expect.objectContaining({
            code: vitest_1.expect.any(String),
            label: vitest_1.expect.any(String),
            summary: vitest_1.expect.any(String),
            severity: vitest_1.expect.any(String),
            category: vitest_1.expect.any(String)
        }));
    });
    (0, vitest_1.it)("includes reason details in verbose text output", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "text", { verbose: true });
        (0, vitest_1.expect)(output).toContain("Reason Codes:");
        (0, vitest_1.expect)(output).toContain("Reason Details:");
        (0, vitest_1.expect)(output).toContain("code: BLOCKED_DESTRUCTIVE_OPERATION");
        (0, vitest_1.expect)(output).toContain("summary:");
    });
    (0, vitest_1.it)("does not include reason details in default text output", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "text");
        (0, vitest_1.expect)(output).toContain("Reason Codes:");
        (0, vitest_1.expect)(output).not.toContain("Reason Details:");
    });
    (0, vitest_1.it)("does not include auditSnapshot in default JSON output", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json");
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.auditSnapshot).toBeUndefined();
    });
    (0, vitest_1.it)("includes auditSnapshot in verbose JSON output", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json", { verbose: true });
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.auditSnapshot).toBeDefined();
        (0, vitest_1.expect)(parsed.auditSnapshot).toEqual(vitest_1.expect.objectContaining({
            mode: "blocked",
            confidenceScore: 25,
            riskScore: 75,
            confidenceFormula: "100 - 50 (destructive) - 25 (schema) = 25"
        }));
        (0, vitest_1.expect)(parsed.auditSnapshot.reasonCodes).toEqual([
            "BLOCKED_DESTRUCTIVE_OPERATION",
            "BLOCKED_SCHEMA_RISK",
            "BLOCKED_HIGH_RISK_SCORE"
        ]);
        (0, vitest_1.expect)(parsed.auditSnapshot.reasonDetails).toHaveLength(3);
        (0, vitest_1.expect)(parsed.auditSnapshot.triggeredBy).toEqual(["riskScore"]);
        (0, vitest_1.expect)(parsed.auditSnapshot.topRiskSummaries).toEqual([
            "[high] Potentially destructive change"
        ]);
    });
    (0, vitest_1.it)("includes audit summary in verbose text output", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "text", { verbose: true });
        (0, vitest_1.expect)(output).toContain("Audit Summary:");
        (0, vitest_1.expect)(output).toContain("triggered by: riskScore");
        (0, vitest_1.expect)(output).toContain("confidence formula: 100 - 50 (destructive) - 25 (schema) = 25");
    });
    (0, vitest_1.it)("keeps auditSnapshot reasonCodes order aligned with root reasonCodes", () => {
        const output = (0, formatOutput_js_1.formatOutput)(mockResult, "json", { verbose: true });
        const parsed = JSON.parse(output);
        (0, vitest_1.expect)(parsed.reasonCodes).toEqual(parsed.auditSnapshot.reasonCodes);
    });
});
//# sourceMappingURL=formatOutput.test.js.map