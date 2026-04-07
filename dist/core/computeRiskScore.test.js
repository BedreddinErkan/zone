"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const computeRiskScore_js_1 = require("./computeRiskScore.js");
(0, vitest_1.describe)("computeRiskScore", () => {
    (0, vitest_1.it)("returns low score for low-risk rename work", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("rename helper function");
        (0, vitest_1.expect)(result.score).toBe(0);
        (0, vitest_1.expect)(result.signals).toContain("low_risk");
    });
    (0, vitest_1.it)("returns medium score for schema work", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("add schema migration for treatment timeline");
        (0, vitest_1.expect)(result.score).toBe(25);
        (0, vitest_1.expect)(result.signals).toContain("schema");
    });
    (0, vitest_1.it)("returns medium score for critical domain work", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("update payment service logic");
        (0, vitest_1.expect)(result.score).toBe(20);
        (0, vitest_1.expect)(result.signals).toContain("critical_domain");
    });
    (0, vitest_1.it)("returns weighted score for destructive database work", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("delete user table from database");
        (0, vitest_1.expect)(result.score).toBe(50);
        (0, vitest_1.expect)(result.signals).toContain("destructive");
        (0, vitest_1.expect)(result.signals).toContain("schema");
    });
    (0, vitest_1.it)("returns mass_scope signal for 'delete all users'", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("delete all users");
        (0, vitest_1.expect)(result.signals).toContain("mass_scope");
        (0, vitest_1.expect)(result.breakdown.massScope).toBe(40);
    });
    (0, vitest_1.it)("does NOT return mass_scope signal for 'truncate sessions' without a scope word", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("truncate sessions");
        (0, vitest_1.expect)(result.signals).not.toContain("mass_scope");
        (0, vitest_1.expect)(result.breakdown.massScope).toBe(0);
    });
    (0, vitest_1.it)("does NOT return mass_scope signal for singular 'delete user'", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("delete user");
        (0, vitest_1.expect)(result.signals).not.toContain("mass_scope");
        (0, vitest_1.expect)(result.breakdown.massScope).toBe(0);
    });
    (0, vitest_1.it)("returns mass_scope signal for 'wipe all data'", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("wipe all data");
        (0, vitest_1.expect)(result.signals).toContain("mass_scope");
        (0, vitest_1.expect)(result.breakdown.massScope).toBe(40);
    });
    (0, vitest_1.it)("returns mass_scope signal for 'purge all cache'", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("purge all cache");
        (0, vitest_1.expect)(result.signals).toContain("mass_scope");
        (0, vitest_1.expect)(result.breakdown.massScope).toBe(40);
    });
    (0, vitest_1.it)("stacks destructive + mass_scope for 'delete all user sessions' with compound penalty", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("delete all user sessions");
        (0, vitest_1.expect)(result.signals).toContain("destructive");
        (0, vitest_1.expect)(result.signals).toContain("mass_scope");
        (0, vitest_1.expect)(result.breakdown.destructive).toBe(50);
        (0, vitest_1.expect)(result.breakdown.massScope).toBe(40);
        (0, vitest_1.expect)(result.score).toBe(100);
    });
    (0, vitest_1.it)("does not treat model test tasks as schema risk", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("add a model test for payment validation");
        (0, vitest_1.expect)(result.signals).not.toContain("schema");
        (0, vitest_1.expect)(result.breakdown.schema).toBe(0);
    });
    (0, vitest_1.it)("adds destructive + critical compound penalty", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("delete auth tokens in production");
        (0, vitest_1.expect)(result.signals).toContain("destructive");
        (0, vitest_1.expect)(result.signals).toContain("critical_domain");
        (0, vitest_1.expect)(result.score).toBe(85);
    });
    (0, vitest_1.it)("clamps score to 100", () => {
        const result = (0, computeRiskScore_js_1.computeRiskScore)("delete remove drop reset overwrite database schema migration payment auth production password token");
        (0, vitest_1.expect)(result.score).toBeLessThanOrEqual(100);
    });
});
//# sourceMappingURL=computeRiskScore.test.js.map