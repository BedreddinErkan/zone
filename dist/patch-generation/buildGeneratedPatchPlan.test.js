"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildGeneratedPatchPlan_js_1 = require("./buildGeneratedPatchPlan.js");
(0, vitest_1.describe)("buildGeneratedPatchPlan", () => {
    (0, vitest_1.it)("builds a structured generated patch plan", () => {
        const result = (0, buildGeneratedPatchPlan_js_1.buildGeneratedPatchPlan)({
            task: "replace foo with bar in src/a.ts",
            decision: {
                mode: "safe_to_apply",
                confidenceScore: 92
            },
            reasonCodes: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"]
        });
        (0, vitest_1.expect)(result.version).toBe(1);
        (0, vitest_1.expect)(typeof result.intent).toBe("string");
        (0, vitest_1.expect)(Array.isArray(result.operations)).toBe(true);
        (0, vitest_1.expect)(typeof result.summary).toBe("string");
        (0, vitest_1.expect)(Array.isArray(result.warnings)).toBe(true);
    });
    (0, vitest_1.it)("adds a warning when decision mode is not safe_to_apply", () => {
        const result = (0, buildGeneratedPatchPlan_js_1.buildGeneratedPatchPlan)({
            task: "rename helper symbol",
            decision: {
                mode: "preview_only",
                confidenceScore: 61
            },
            reasonCodes: ["PREVIEW_LOW_CONFIDENCE"]
        });
        (0, vitest_1.expect)(result.warnings.some((item) => item.includes("preview_only"))).toBe(true);
    });
});
//# sourceMappingURL=buildGeneratedPatchPlan.test.js.map