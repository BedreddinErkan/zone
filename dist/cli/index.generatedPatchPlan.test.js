"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runGeneratedPatchPlanFlow_js_1 = require("./runGeneratedPatchPlanFlow.js");
(0, vitest_1.describe)("generated patch plan CLI integration", () => {
    (0, vitest_1.it)("blocks safely when conversion fails", () => {
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
            preview: "preview output",
        });
        (0, vitest_1.expect)(result.ok).toBe(false);
        if (result.ok) {
            throw new Error("Expected blocked result.");
        }
        (0, vitest_1.expect)(result.code).toBe("PLACEHOLDER_FILE_PATH");
        (0, vitest_1.expect)(result.reason).toBe('Generated patch operation contains placeholder filePath "unknown".');
    });
    (0, vitest_1.it)("returns a patch plan on successful conversion", () => {
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
            preview: "preview output",
        });
        (0, vitest_1.expect)(result).toEqual({
            ok: true,
            preview: "preview output",
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
//# sourceMappingURL=index.generatedPatchPlan.test.js.map