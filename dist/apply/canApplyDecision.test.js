"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const canApplyDecision_js_1 = require("./canApplyDecision.js");
function buildRunAgentResult(mode) {
    return {
        task: "rename helper function",
        decision: {
            mode,
            confidenceScore: 82
        },
        risk: {
            score: 18,
            breakdown: {
                destructive: 0,
                schema: 0,
                critical: 0,
                lowRisk: 10,
                massScope: 0
            }
        },
        confidence: {
            score: 82,
            breakdown: {
                base: 100,
                destructivePenalty: 0,
                schemaPenalty: 0,
                criticalPenalty: 0,
                massScopePenalty: 0,
                lowRiskBonus: 0
            }
        },
        explanation: "SAFE TO APPLY",
        recommendation: "Safe",
        topRisks: [],
        trace: {}, // ✅ FIX
        reasonCodes: []
    };
}
(0, vitest_1.describe)("canApplyDecision", () => {
    (0, vitest_1.it)("returns blocked eligibility for blocked mode", () => {
        const result = buildRunAgentResult("blocked");
        const eligibility = (0, canApplyDecision_js_1.canApplyDecision)(result);
        (0, vitest_1.expect)(eligibility).toEqual({
            allowed: false,
            reason: "blocked_mode",
            message: "Blocked decisions cannot be applied."
        });
    });
    (0, vitest_1.it)("returns confirmed apply eligibility for preview_only mode", () => {
        const result = buildRunAgentResult("preview_only");
        const eligibility = (0, canApplyDecision_js_1.canApplyDecision)(result);
        (0, vitest_1.expect)(eligibility).toEqual({
            allowed: true,
            strategy: "confirmed_apply",
            message: "Preview-only decisions may be applied only with explicit confirmation."
        });
    });
    (0, vitest_1.it)("returns confirmed apply eligibility for safe_to_apply mode", () => {
        const result = buildRunAgentResult("safe_to_apply");
        const eligibility = (0, canApplyDecision_js_1.canApplyDecision)(result);
        (0, vitest_1.expect)(eligibility).toEqual({
            allowed: true,
            strategy: "confirmed_apply",
            message: "Safe-to-apply decisions may be applied with explicit confirmation."
        });
    });
});
//# sourceMappingURL=canApplyDecision.test.js.map