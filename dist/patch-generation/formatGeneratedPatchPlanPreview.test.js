"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const formatGeneratedPatchPlanPreview_js_1 = require("./formatGeneratedPatchPlanPreview.js");
(0, vitest_1.describe)("formatGeneratedPatchPlanPreview", () => {
    (0, vitest_1.it)("returns a stable structured preview result", () => {
        const result = (0, formatGeneratedPatchPlanPreview_js_1.formatGeneratedPatchPlanPreview)({
            version: 1,
            intent: "safe_replace",
            summary: "Replace text in one file.",
            warnings: [],
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/index.ts",
                    find: "oldValue",
                    replaceWith: "newValue",
                    matchMode: "exact"
                }
            ]
        });
        (0, vitest_1.expect)(result).toEqual({
            stage: "generated_patch_preview",
            status: "info",
            summary: "Generated patch preview contains 1 operation.",
            details: "1. safe_replace -> src/index.ts",
            operationCount: 1
        });
    });
    (0, vitest_1.it)("returns an empty preview summary when no operations exist", () => {
        const result = (0, formatGeneratedPatchPlanPreview_js_1.formatGeneratedPatchPlanPreview)({
            version: 1,
            intent: "safe_replace",
            summary: "No changes.",
            warnings: [],
            operations: []
        });
        (0, vitest_1.expect)(result).toEqual({
            stage: "generated_patch_preview",
            status: "info",
            summary: "Generated patch preview contains 0 operations.",
            details: "No operations were generated.",
            operationCount: 0
        });
    });
});
//# sourceMappingURL=formatGeneratedPatchPlanPreview.test.js.map