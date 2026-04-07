"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const computeConfidenceScore_js_1 = require("./computeConfidenceScore.js");
(0, vitest_1.describe)("computeConfidenceScore", () => {
    (0, vitest_1.it)("returns full confidence for zero-risk input", () => {
        const result = (0, computeConfidenceScore_js_1.computeConfidenceScore)({
            breakdown: {
                destructive: 0,
                schema: 0,
                critical: 0,
                massScope: 0,
                lowRisk: 0
            }
        });
        (0, vitest_1.expect)(result.score).toBe(100);
        (0, vitest_1.expect)(result.breakdown).toEqual({
            base: 100,
            destructivePenalty: 0,
            schemaPenalty: 0,
            criticalPenalty: 0,
            massScopePenalty: 0,
            lowRiskBonus: 0
        });
    });
    (0, vitest_1.it)("applies destructive penalty", () => {
        const result = (0, computeConfidenceScore_js_1.computeConfidenceScore)({
            breakdown: {
                destructive: 50,
                schema: 0,
                critical: 0,
                massScope: 0,
                lowRisk: 0
            }
        });
        (0, vitest_1.expect)(result.score).toBe(50);
        (0, vitest_1.expect)(result.breakdown.destructivePenalty).toBe(-50);
    });
    (0, vitest_1.it)("applies schema and critical penalties together", () => {
        const result = (0, computeConfidenceScore_js_1.computeConfidenceScore)({
            breakdown: {
                destructive: 0,
                schema: 25,
                critical: 20,
                massScope: 0,
                lowRisk: 0
            }
        });
        (0, vitest_1.expect)(result.score).toBe(55);
        (0, vitest_1.expect)(result.breakdown.schemaPenalty).toBe(-25);
        (0, vitest_1.expect)(result.breakdown.criticalPenalty).toBe(-20);
    });
    (0, vitest_1.it)("applies mass_scope penalty", () => {
        const result = (0, computeConfidenceScore_js_1.computeConfidenceScore)({
            breakdown: {
                destructive: 0,
                schema: 0,
                critical: 0,
                massScope: 30,
                lowRisk: 0
            }
        });
        (0, vitest_1.expect)(result.score).toBe(85);
        (0, vitest_1.expect)(result.breakdown.massScopePenalty).toBe(-30);
    });
    (0, vitest_1.it)("applies mass_scope together with other penalties", () => {
        const result = (0, computeConfidenceScore_js_1.computeConfidenceScore)({
            breakdown: {
                destructive: 50,
                schema: 0,
                critical: 0,
                massScope: 30,
                lowRisk: 0
            }
        });
        (0, vitest_1.expect)(result.score).toBe(20);
        (0, vitest_1.expect)(result.breakdown.destructivePenalty).toBe(-50);
        (0, vitest_1.expect)(result.breakdown.massScopePenalty).toBe(-30);
    });
});
//# sourceMappingURL=computeConfidenceScore.test.js.map