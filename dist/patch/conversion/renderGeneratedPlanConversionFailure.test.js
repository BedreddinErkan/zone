"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const renderGeneratedPlanConversionFailure_js_1 = require("./renderGeneratedPlanConversionFailure.js");
(0, vitest_1.describe)("renderGeneratedPlanConversionFailure", () => {
    (0, vitest_1.it)("renders deterministic failure output", () => {
        const output = (0, renderGeneratedPlanConversionFailure_js_1.renderGeneratedPlanConversionFailure)({
            canConvert: false,
            code: "EMPTY_OPERATIONS",
            reason: "Generated plan must contain exactly one operation."
        });
        (0, vitest_1.expect)(output).toBe([
            "=== GENERATED PATCH PLAN CONVERSION ===",
            "Status: failed",
            "Reason code: EMPTY_OPERATIONS",
            "Summary: Generated plan contains no operations.",
            "Details: Generated plan must contain exactly one operation.",
            "Apply status: blocked",
            "No changes were applied."
        ].join("\n"));
    });
    (0, vitest_1.it)("falls back when meta is missing", () => {
        const output = (0, renderGeneratedPlanConversionFailure_js_1.renderGeneratedPlanConversionFailure)({
            canConvert: false,
            code: "UNKNOWN_CODE",
            reason: "something"
        });
        (0, vitest_1.expect)(output).toContain("Generated plan conversion failed.");
    });
});
//# sourceMappingURL=renderGeneratedPlanConversionFailure.test.js.map