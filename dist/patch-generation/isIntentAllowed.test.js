"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const isIntentAllowed_js_1 = require("./isIntentAllowed.js");
(0, vitest_1.describe)("isIntentAllowed", () => {
    (0, vitest_1.it)("rejects all intents for blocked strategy", () => {
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("rename_symbol", "blocked")).toBe(false);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("update_import", "blocked")).toBe(false);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("add_comment", "blocked")).toBe(false);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("safe_replace", "blocked")).toBe(false);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("unknown", "blocked")).toBe(false);
    });
    (0, vitest_1.it)("allows only restricted-safe intents for restricted strategy", () => {
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("rename_symbol", "restricted")).toBe(true);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("add_comment", "restricted")).toBe(true);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("safe_replace", "restricted")).toBe(true);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("update_import", "restricted")).toBe(false);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("unknown", "restricted")).toBe(false);
    });
    (0, vitest_1.it)("allows all supported intents except unknown for safe strategy", () => {
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("rename_symbol", "safe")).toBe(true);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("update_import", "safe")).toBe(true);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("add_comment", "safe")).toBe(true);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("safe_replace", "safe")).toBe(true);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("unknown", "safe")).toBe(false);
    });
    (0, vitest_1.it)("always rejects unknown intent regardless of strategy", () => {
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("unknown", "blocked")).toBe(false);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("unknown", "restricted")).toBe(false);
        (0, vitest_1.expect)((0, isIntentAllowed_js_1.isIntentAllowed)("unknown", "safe")).toBe(false);
    });
});
//# sourceMappingURL=isIntentAllowed.test.js.map