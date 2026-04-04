"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runGeneratedPatchPlanFlow_js_1 = require("./runGeneratedPatchPlanFlow.js");
(0, vitest_1.describe)("runGeneratedPatchPlanFlow", () => {
    (0, vitest_1.it)("returns blocked result when generated plan cannot be converted", () => {
        const generatedPlan = {
            intent: "replace_exact_text",
            operations: [
                {
                    filePath: "unknown",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        };
        const result = (0, runGeneratedPatchPlanFlow_js_1.runGeneratedPatchPlanFlow)({
            generatedPlan,
            preview: "preview text",
        });
        (0, vitest_1.expect)(result).toEqual({
            ok: false,
            preview: "preview text",
            code: "PLACEHOLDER_FILE_PATH",
            reason: 'Generated patch operation contains placeholder filePath "unknown".',
        });
    });
    (0, vitest_1.it)("returns converted patch plan when generated plan is valid", () => {
        const generatedPlan = {
            intent: "replace_exact_text",
            operations: [
                {
                    filePath: "src/example.ts",
                    find: "oldText",
                    replaceWith: "newText",
                    matchMode: "exact",
                },
            ],
        };
        const result = (0, runGeneratedPatchPlanFlow_js_1.runGeneratedPatchPlanFlow)({
            generatedPlan,
            preview: "preview text",
        });
        (0, vitest_1.expect)(result).toEqual({
            ok: true,
            preview: "preview text",
            patchPlan: {
                operations: [
                    {
                        type: "replace",
                        filePath: "src/example.ts",
                        find: "oldText",
                        replaceWith: "newText",
                        matchMode: "exact",
                    },
                ],
            },
        });
    });
});
//# sourceMappingURL=runGeneratedPatchPlanFlow.test.js.map