"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildPatchOperations_js_1 = require("./buildPatchOperations.js");
(0, vitest_1.describe)("buildPatchOperations", () => {
    (0, vitest_1.it)("builds a rename operation for rename_symbol intent", () => {
        (0, vitest_1.expect)((0, buildPatchOperations_js_1.buildPatchOperations)("rename_symbol")).toEqual([
            {
                type: "rename",
                scope: "single_file"
            }
        ]);
    });
    (0, vitest_1.it)("builds an update_import operation for update_import intent", () => {
        (0, vitest_1.expect)((0, buildPatchOperations_js_1.buildPatchOperations)("update_import")).toEqual([
            {
                type: "update_import",
                scope: "single_file"
            }
        ]);
    });
    (0, vitest_1.it)("builds an insert_comment operation for add_comment intent", () => {
        (0, vitest_1.expect)((0, buildPatchOperations_js_1.buildPatchOperations)("add_comment")).toEqual([
            {
                type: "insert_comment",
                scope: "single_file",
                position: "line_above_target"
            }
        ]);
    });
    (0, vitest_1.it)("builds a replace_text operation for safe_replace intent", () => {
        (0, vitest_1.expect)((0, buildPatchOperations_js_1.buildPatchOperations)("safe_replace")).toEqual([
            {
                type: "replace_text",
                scope: "single_file",
                matchMode: "exact"
            }
        ]);
    });
    (0, vitest_1.it)("returns an empty array for unknown intent", () => {
        (0, vitest_1.expect)((0, buildPatchOperations_js_1.buildPatchOperations)("unknown")).toEqual([]);
    });
    (0, vitest_1.it)("returns deterministic results for repeated calls", () => {
        const first = (0, buildPatchOperations_js_1.buildPatchOperations)("rename_symbol");
        const second = (0, buildPatchOperations_js_1.buildPatchOperations)("rename_symbol");
        (0, vitest_1.expect)(first).toEqual(second);
    });
});
//# sourceMappingURL=buildPatchOperations.test.js.map