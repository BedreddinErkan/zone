"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const formatApplyFlowResult_js_1 = require("./formatApplyFlowResult.js");
(0, vitest_1.describe)("formatApplyFlowResult", () => {
    (0, vitest_1.it)("returns a stable structured result", () => {
        (0, vitest_1.expect)((0, formatApplyFlowResult_js_1.formatApplyFlowResult)({
            status: "applied",
            operationsAttempted: 1,
            operationsApplied: 1,
            filesTouched: ["src/index.ts"],
            backupCreated: true,
            message: "Patch applied successfully.",
            operationResults: [
                {
                    index: 0,
                    type: "safe_replace",
                    filePath: "src/index.ts",
                    status: "applied",
                    message: "Operation applied successfully."
                }
            ]
        })).toEqual({
            stage: "apply",
            status: "success",
            summary: "Patch applied successfully.",
            details: "Files touched: src/index.ts",
            operationsAttempted: 1,
            operationsApplied: 1,
            filesTouched: ["src/index.ts"],
            backupCreated: true,
            operationResults: [
                {
                    index: 0,
                    type: "safe_replace",
                    filePath: "src/index.ts",
                    status: "applied",
                    message: "Operation applied successfully."
                }
            ]
        });
    });
});
//# sourceMappingURL=renderApplyFlowResult.test.js.map