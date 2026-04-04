"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runAgent_js_1 = require("./runAgent.js");
// ---------------------------------------------------------------------------
// buildPrimaryCause
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildPrimaryCause", () => {
    (0, vitest_1.it)("returns 'destructive operation' for destructive signal", () => {
        (0, vitest_1.expect)((0, runAgent_js_1.buildPrimaryCause)(["destructive"])).toBe("destructive operation");
    });
    (0, vitest_1.it)("returns 'schema-sensitive change' for schema signal", () => {
        (0, vitest_1.expect)((0, runAgent_js_1.buildPrimaryCause)(["schema"])).toBe("schema-sensitive change");
    });
    (0, vitest_1.it)("returns 'critical domain access' for critical_domain signal", () => {
        (0, vitest_1.expect)((0, runAgent_js_1.buildPrimaryCause)(["critical_domain"])).toBe("critical domain access");
    });
    (0, vitest_1.it)("returns 'mass-scope operation' for mass_scope signal", () => {
        (0, vitest_1.expect)((0, runAgent_js_1.buildPrimaryCause)(["mass_scope"])).toBe("mass-scope operation");
    });
    (0, vitest_1.it)("prefers destructive over schema when both are present (priority order)", () => {
        (0, vitest_1.expect)((0, runAgent_js_1.buildPrimaryCause)(["destructive", "schema"])).toBe("destructive operation");
    });
    (0, vitest_1.it)("prefers schema over critical_domain when both are present", () => {
        (0, vitest_1.expect)((0, runAgent_js_1.buildPrimaryCause)(["schema", "critical_domain"])).toBe("schema-sensitive change");
    });
    (0, vitest_1.it)("prefers critical_domain over mass_scope when both are present", () => {
        (0, vitest_1.expect)((0, runAgent_js_1.buildPrimaryCause)(["critical_domain", "mass_scope"])).toBe("critical domain access");
    });
    (0, vitest_1.it)("returns 'general task' for low_risk-only signal", () => {
        (0, vitest_1.expect)((0, runAgent_js_1.buildPrimaryCause)(["low_risk"])).toBe("general task");
    });
    (0, vitest_1.it)("returns 'general task' for empty signals", () => {
        (0, vitest_1.expect)((0, runAgent_js_1.buildPrimaryCause)([])).toBe("general task");
    });
});
// ---------------------------------------------------------------------------
// buildConfidenceImpactLine
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildConfidenceImpactLine", () => {
    (0, vitest_1.it)("returns schema penalty line for schema-only penalty", () => {
        const breakdown = {
            base: 100,
            destructivePenalty: 0,
            schemaPenalty: -25,
            criticalPenalty: 0,
            lowRiskBonus: 0,
            massScopePenalty: 0,
        };
        (0, vitest_1.expect)((0, runAgent_js_1.buildConfidenceImpactLine)(breakdown)).toBe("schema penalty: -25");
    });
    (0, vitest_1.it)("returns combined line for destructive + schema penalties", () => {
        const breakdown = {
            base: 100,
            destructivePenalty: -50,
            schemaPenalty: -25,
            criticalPenalty: 0,
            lowRiskBonus: 0,
            massScopePenalty: 0,
        };
        (0, vitest_1.expect)((0, runAgent_js_1.buildConfidenceImpactLine)(breakdown)).toBe("destructive penalty: -50, schema penalty: -25");
    });
    (0, vitest_1.it)("returns critical penalty line", () => {
        const breakdown = {
            base: 100,
            destructivePenalty: 0,
            schemaPenalty: 0,
            criticalPenalty: -15,
            lowRiskBonus: 0,
            massScopePenalty: 0,
        };
        (0, vitest_1.expect)((0, runAgent_js_1.buildConfidenceImpactLine)(breakdown)).toBe("critical penalty: -15");
    });
    (0, vitest_1.it)("returns low-risk bonus line with explicit + prefix", () => {
        const breakdown = {
            base: 100,
            destructivePenalty: 0,
            schemaPenalty: 0,
            criticalPenalty: 0,
            lowRiskBonus: 10,
            massScopePenalty: 0,
        };
        (0, vitest_1.expect)((0, runAgent_js_1.buildConfidenceImpactLine)(breakdown)).toBe("low-risk bonus: +10");
    });
    (0, vitest_1.it)("returns null when all adjustments are zero", () => {
        const breakdown = {
            base: 100,
            destructivePenalty: 0,
            schemaPenalty: 0,
            criticalPenalty: 0,
            lowRiskBonus: 0,
            massScopePenalty: 0,
        };
        (0, vitest_1.expect)((0, runAgent_js_1.buildConfidenceImpactLine)(breakdown)).toBeNull();
    });
    (0, vitest_1.it)("includes all non-zero adjustments in correct order", () => {
        const breakdown = {
            base: 100,
            destructivePenalty: -50,
            schemaPenalty: -25,
            criticalPenalty: -15,
            lowRiskBonus: 5,
            massScopePenalty: 0,
        };
        (0, vitest_1.expect)((0, runAgent_js_1.buildConfidenceImpactLine)(breakdown)).toBe("destructive penalty: -50, schema penalty: -25, critical penalty: -15, low-risk bonus: +5");
    });
});
//# sourceMappingURL=buildExplanationHelpers.test.js.map