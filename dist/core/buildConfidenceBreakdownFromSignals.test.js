"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildConfidenceBreakdownFromSignals_js_1 = require("./buildConfidenceBreakdownFromSignals.js");
(0, vitest_1.describe)("buildConfidenceBreakdownFromSignals", () => {
    (0, vitest_1.it)("returns zeroed breakdown for empty signals", () => {
        const result = (0, buildConfidenceBreakdownFromSignals_js_1.buildConfidenceBreakdownFromSignals)([]);
        (0, vitest_1.expect)(result).toEqual({
            destructive: 0,
            schema: 0,
            critical: 0,
            massScope: 0,
            lowRisk: 0
        });
    });
    (0, vitest_1.it)("maps destructive signal to destructive penalty input", () => {
        const result = (0, buildConfidenceBreakdownFromSignals_js_1.buildConfidenceBreakdownFromSignals)(["destructive"]);
        (0, vitest_1.expect)(result).toEqual({
            destructive: 50,
            schema: 0,
            critical: 0,
            massScope: 0,
            lowRisk: 0
        });
    });
    (0, vitest_1.it)("maps schema, critical_domain, and mass_scope correctly", () => {
        const result = (0, buildConfidenceBreakdownFromSignals_js_1.buildConfidenceBreakdownFromSignals)([
            "schema",
            "critical_domain",
            "mass_scope"
        ]);
        (0, vitest_1.expect)(result).toEqual({
            destructive: 0,
            schema: 25,
            critical: 20,
            massScope: 25,
            lowRisk: 0
        });
    });
    (0, vitest_1.it)("maps low_risk to bonus-compatible negative value", () => {
        const result = (0, buildConfidenceBreakdownFromSignals_js_1.buildConfidenceBreakdownFromSignals)(["low_risk"]);
        (0, vitest_1.expect)(result).toEqual({
            destructive: 0,
            schema: 0,
            critical: 0,
            massScope: 0,
            lowRisk: -20
        });
    });
    (0, vitest_1.it)("combines multiple signals deterministically", () => {
        const result = (0, buildConfidenceBreakdownFromSignals_js_1.buildConfidenceBreakdownFromSignals)([
            "destructive",
            "schema",
            "mass_scope",
            "low_risk"
        ]);
        (0, vitest_1.expect)(result).toEqual({
            destructive: 50,
            schema: 25,
            critical: 0,
            massScope: 25,
            lowRisk: -20
        });
    });
});
//# sourceMappingURL=buildConfidenceBreakdownFromSignals.test.js.map