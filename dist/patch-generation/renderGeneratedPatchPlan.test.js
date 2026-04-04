"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const renderGeneratedPatchPlan_js_1 = require("./renderGeneratedPatchPlan.js");
(0, vitest_1.describe)("renderGeneratedPatchPlan", () => {
    (0, vitest_1.it)("renders add_comment plan", () => {
        const plan = {
            version: 1,
            intent: "add_comment",
            summary: "Adds a comment in a deterministic location.",
            warnings: [],
            operations: [
                {
                    type: "add_comment",
                    filePath: "src/helpers.ts",
                    comment: "TODO: revisit helper behavior",
                    target: "function helper"
                }
            ]
        };
        const output = (0, renderGeneratedPatchPlan_js_1.renderGeneratedPatchPlan)(plan);
        (0, vitest_1.expect)(output).toContain("=== GENERATED PATCH PLAN ===");
        (0, vitest_1.expect)(output).toContain("Intent: add_comment");
        (0, vitest_1.expect)(output).toContain("Summary: Adds a comment in a deterministic location.");
        (0, vitest_1.expect)(output).toContain("Operations:");
        (0, vitest_1.expect)(output).toContain("type: add_comment");
        (0, vitest_1.expect)(output).toContain("filePath: src/helpers.ts");
        (0, vitest_1.expect)(output).toContain("comment: TODO: revisit helper behavior");
        (0, vitest_1.expect)(output).toContain("target: function helper");
    });
    (0, vitest_1.it)("renders safe_replace plan", () => {
        const plan = {
            version: 1,
            intent: "safe_replace",
            summary: "Performs a safe deterministic replacement.",
            warnings: [],
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/config.ts",
                    find: "OLD_VALUE",
                    replaceWith: "NEW_VALUE",
                    matchMode: "exact"
                }
            ]
        };
        const output = (0, renderGeneratedPatchPlan_js_1.renderGeneratedPatchPlan)(plan);
        (0, vitest_1.expect)(output).toContain("Intent: safe_replace");
        (0, vitest_1.expect)(output).toContain("Summary: Performs a safe deterministic replacement.");
        (0, vitest_1.expect)(output).toContain("type: safe_replace");
        (0, vitest_1.expect)(output).toContain("filePath: src/config.ts");
        (0, vitest_1.expect)(output).toContain("find: OLD_VALUE");
        (0, vitest_1.expect)(output).toContain("replaceWith: NEW_VALUE");
        (0, vitest_1.expect)(output).toContain("matchMode: exact");
    });
    (0, vitest_1.it)("renders update_import plan", () => {
        const plan = {
            version: 1,
            intent: "update_import",
            summary: "Updates an import path in a deterministic way.",
            warnings: [],
            operations: [
                {
                    type: "update_import",
                    filePath: "src/index.ts",
                    from: "./old/module",
                    to: "./new/module"
                }
            ]
        };
        const output = (0, renderGeneratedPatchPlan_js_1.renderGeneratedPatchPlan)(plan);
        (0, vitest_1.expect)(output).toContain("Intent: update_import");
        (0, vitest_1.expect)(output).toContain("type: update_import");
        (0, vitest_1.expect)(output).toContain("filePath: src/index.ts");
        (0, vitest_1.expect)(output).toContain("from: ./old/module");
        (0, vitest_1.expect)(output).toContain("to: ./new/module");
    });
    (0, vitest_1.it)("renders rename_symbol plan", () => {
        const plan = {
            version: 1,
            intent: "rename_symbol",
            summary: "Renames a symbol intent in preview form.",
            warnings: [],
            operations: [
                {
                    type: "rename_symbol",
                    filePath: "src/userService.ts",
                    from: "getUser",
                    to: "fetchUser"
                }
            ]
        };
        const output = (0, renderGeneratedPatchPlan_js_1.renderGeneratedPatchPlan)(plan);
        (0, vitest_1.expect)(output).toContain("Intent: rename_symbol");
        (0, vitest_1.expect)(output).toContain("type: rename_symbol");
        (0, vitest_1.expect)(output).toContain("filePath: src/userService.ts");
        (0, vitest_1.expect)(output).toContain("from: getUser");
        (0, vitest_1.expect)(output).toContain("to: fetchUser");
    });
    (0, vitest_1.it)("renders warnings section when warnings exist", () => {
        const plan = {
            version: 1,
            intent: "rename_symbol",
            summary: "Renames a symbol intent in preview form.",
            warnings: [
                "Decision mode is 'preview_only', so generated operations are preview-oriented.",
                "Intent 'rename_symbol' is not convertible to a real PatchPlan in v1 unless explicitly supported."
            ],
            operations: [
                {
                    type: "rename_symbol",
                    filePath: "src/userService.ts",
                    from: "getUser",
                    to: "fetchUser"
                }
            ]
        };
        const output = (0, renderGeneratedPatchPlan_js_1.renderGeneratedPatchPlan)(plan);
        (0, vitest_1.expect)(output).toContain("Warnings:");
        (0, vitest_1.expect)(output).toContain("Decision mode is 'preview_only', so generated operations are preview-oriented.");
        (0, vitest_1.expect)(output).toContain("Intent 'rename_symbol' is not convertible to a real PatchPlan in v1 unless explicitly supported.");
    });
    (0, vitest_1.it)("renders empty operations as none", () => {
        const plan = {
            version: 1,
            intent: "add_comment",
            summary: "Adds a comment in a deterministic location.",
            warnings: [],
            operations: []
        };
        const output = (0, renderGeneratedPatchPlan_js_1.renderGeneratedPatchPlan)(plan);
        (0, vitest_1.expect)(output).toContain("Operations:");
        (0, vitest_1.expect)(output).toContain("(none)");
    });
    (0, vitest_1.it)("is deterministic for the same plan", () => {
        const plan = {
            version: 1,
            intent: "safe_replace",
            summary: "Performs a safe deterministic replacement.",
            warnings: ["Reason codes: SAFE_LOW_RISK"],
            operations: [
                {
                    type: "safe_replace",
                    filePath: "src/config.ts",
                    find: "OLD_VALUE",
                    replaceWith: "NEW_VALUE",
                    matchMode: "exact"
                }
            ]
        };
        const first = (0, renderGeneratedPatchPlan_js_1.renderGeneratedPatchPlan)(plan);
        const second = (0, renderGeneratedPatchPlan_js_1.renderGeneratedPatchPlan)(plan);
        (0, vitest_1.expect)(first).toBe(second);
    });
});
//# sourceMappingURL=renderGeneratedPatchPlan.test.js.map