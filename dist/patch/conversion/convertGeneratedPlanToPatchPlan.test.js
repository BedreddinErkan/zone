"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const convertGeneratedPlanToPatchPlan_js_1 = require("./convertGeneratedPlanToPatchPlan.js");
function buildPlan(overrides) {
    return {
        version: 1,
        summary: "generated plan",
        warnings: [],
        intent: "safe_replace",
        operations: [],
        ...overrides,
    };
}
(0, vitest_1.describe)("convertGeneratedPlanToPatchPlan", () => {
    (0, vitest_1.it)("throws when generated plan is not convertible", () => {
        (0, vitest_1.expect)(() => (0, convertGeneratedPlanToPatchPlan_js_1.convertGeneratedPlanToPatchPlan)(buildPlan({
            intent: "rename_symbol",
            operations: [
                {
                    type: "rename_symbol",
                    filePath: "src/example.ts",
                    from: "oldName",
                    to: "newName",
                },
            ],
        }))).toThrow('[UNSUPPORTED_INTENT] Cannot convert generated patch plan: Generated patch intent "rename_symbol" is not supported for PatchPlan conversion.');
    });
    (0, vitest_1.it)("converts a supported safe_replace generated plan into PatchPlan", () => {
        const result = (0, convertGeneratedPlanToPatchPlan_js_1.convertGeneratedPlanToPatchPlan)(buildPlan({
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/example.ts",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        }));
        (0, vitest_1.expect)(result).toEqual({
            operations: [
                {
                    type: "replace",
                    filePath: "src/example.ts",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        });
    });
});
//# sourceMappingURL=convertGeneratedPlanToPatchPlan.test.js.map