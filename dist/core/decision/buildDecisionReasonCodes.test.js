"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildDecisionReasonCodes_js_1 = require("./buildDecisionReasonCodes.js");
(0, vitest_1.describe)("buildDecisionReasonCodes", () => {
    (0, vitest_1.it)("returns blocked destructive and high risk codes", () => {
        const result = (0, buildDecisionReasonCodes_js_1.buildDecisionReasonCodes)({
            mode: "blocked",
            riskScore: 80,
            confidenceScore: 25,
            normalizedSignals: [{ type: "destructive" }]
        });
        (0, vitest_1.expect)(result).toContain("BLOCKED_DESTRUCTIVE_OPERATION");
        (0, vitest_1.expect)(result).toContain("BLOCKED_HIGH_RISK_SCORE");
    });
    (0, vitest_1.it)("returns blocked schema risk code", () => {
        const result = (0, buildDecisionReasonCodes_js_1.buildDecisionReasonCodes)({
            mode: "blocked",
            riskScore: 72,
            confidenceScore: 40,
            normalizedSignals: [{ type: "schema" }]
        });
        (0, vitest_1.expect)(result).toContain("BLOCKED_SCHEMA_RISK");
    });
    (0, vitest_1.it)("returns preview mass scope and low confidence codes", () => {
        const result = (0, buildDecisionReasonCodes_js_1.buildDecisionReasonCodes)({
            mode: "preview_only",
            riskScore: 45,
            confidenceScore: 55,
            normalizedSignals: [{ type: "massScope" }]
        });
        (0, vitest_1.expect)(result).toContain("PREVIEW_MASS_SCOPE_CHANGE");
        (0, vitest_1.expect)(result).toContain("PREVIEW_LOW_CONFIDENCE");
    });
    (0, vitest_1.it)("returns preview schema uncertainty code", () => {
        const result = (0, buildDecisionReasonCodes_js_1.buildDecisionReasonCodes)({
            mode: "preview_only",
            riskScore: 30,
            confidenceScore: 60,
            normalizedSignals: [{ type: "schema" }]
        });
        (0, vitest_1.expect)(result).toContain("PREVIEW_SCHEMA_UNCERTAINTY");
    });
    (0, vitest_1.it)("returns safe low risk and high confidence codes", () => {
        const result = (0, buildDecisionReasonCodes_js_1.buildDecisionReasonCodes)({
            mode: "safe_to_apply",
            riskScore: 5,
            confidenceScore: 92,
            normalizedSignals: [{ type: "lowRisk" }]
        });
        (0, vitest_1.expect)(result).toContain("SAFE_LOW_RISK_LOCALIZED");
        (0, vitest_1.expect)(result).toContain("SAFE_HIGH_CONFIDENCE");
    });
    (0, vitest_1.it)("does not return duplicate codes", () => {
        const result = (0, buildDecisionReasonCodes_js_1.buildDecisionReasonCodes)({
            mode: "blocked",
            riskScore: 85,
            confidenceScore: 20,
            normalizedSignals: [
                { type: "destructive" },
                { type: "destructive" }
            ]
        });
        const destructiveCodes = result.filter((code) => code === "BLOCKED_DESTRUCTIVE_OPERATION");
        (0, vitest_1.expect)(destructiveCodes).toHaveLength(1);
    });
    (0, vitest_1.it)("returns an empty array when no rule matches", () => {
        const result = (0, buildDecisionReasonCodes_js_1.buildDecisionReasonCodes)({
            mode: "safe_to_apply",
            riskScore: 20,
            confidenceScore: 60,
            normalizedSignals: []
        });
        (0, vitest_1.expect)(result).toEqual([]);
    });
});
//# sourceMappingURL=buildDecisionReasonCodes.test.js.map