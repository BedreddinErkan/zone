"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const normalizeSignals_js_1 = require("./normalizeSignals.js");
(0, vitest_1.describe)("normalizeSignals", () => {
    (0, vitest_1.it)("normalizes destructive signal", () => {
        const result = (0, normalizeSignals_js_1.normalizeSignals)(["destructive"]);
        (0, vitest_1.expect)(result[0]).toMatchObject({
            type: "destructive",
            severity: "high",
            confidenceImpact: -50
        });
    });
    (0, vitest_1.it)("normalizes multiple signals", () => {
        const result = (0, normalizeSignals_js_1.normalizeSignals)(["schema", "mass_scope"]);
        (0, vitest_1.expect)(result).toHaveLength(2);
        (0, vitest_1.expect)(result.map((r) => r.type)).toEqual(["schema", "mass_scope"]);
    });
    (0, vitest_1.it)("returns empty for no signals", () => {
        const result = (0, normalizeSignals_js_1.normalizeSignals)([]);
        (0, vitest_1.expect)(result).toHaveLength(0);
    });
});
//# sourceMappingURL=normalizeSignals.test.js.map