"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const classifyPatchIntent_js_1 = require("./classifyPatchIntent.js");
(0, vitest_1.describe)("classifyPatchIntent", () => {
    (0, vitest_1.it)("returns rename_symbol for rename-related tasks", () => {
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("rename helper function")).toBe("rename_symbol");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("Rename variable in utils")).toBe("rename_symbol");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("change name of method")).toBe("rename_symbol");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("rename class in parser module")).toBe("rename_symbol");
    });
    (0, vitest_1.it)("returns update_import for import-related tasks", () => {
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("update import path in api client")).toBe("update_import");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("fix import after file move")).toBe("update_import");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("change import in service")).toBe("update_import");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("adjust import for renamed module")).toBe("update_import");
    });
    (0, vitest_1.it)("returns add_comment for comment-related tasks", () => {
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("add comment to explain fallback")).toBe("add_comment");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("insert comment above helper")).toBe("add_comment");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("append comment to file")).toBe("add_comment");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("document with comment")).toBe("add_comment");
    });
    (0, vitest_1.it)("returns safe_replace for replace-related tasks", () => {
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("replace exact text in config")).toBe("safe_replace");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("safe replace deprecated label")).toBe("safe_replace");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("replace string in constants")).toBe("safe_replace");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("update text in README")).toBe("safe_replace");
    });
    (0, vitest_1.it)("returns unknown for unsupported tasks", () => {
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("refactor authentication flow")).toBe("unknown");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("rewrite business logic")).toBe("unknown");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("optimize performance")).toBe("unknown");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("restructure project architecture")).toBe("unknown");
    });
    (0, vitest_1.it)("returns unknown for empty or whitespace-only tasks", () => {
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("")).toBe("unknown");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("   ")).toBe("unknown");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("\n\t")).toBe("unknown");
    });
    (0, vitest_1.it)("is case-insensitive", () => {
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("RENAME HELPER FUNCTION")).toBe("rename_symbol");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("ADD COMMENT TO FILE")).toBe("add_comment");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("FIX IMPORT PATH")).toBe("update_import");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("REPLACE EXACT TEXT")).toBe("safe_replace");
    });
    (0, vitest_1.it)("applies deterministic category precedence when multiple intents match", () => {
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("rename function and update import")).toBe("update_import");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("add comment and replace text")).toBe("add_comment");
    });
    (0, vitest_1.it)("applies deterministic category precedence when multiple intents match", () => {
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("rename function and update import")).toBe("update_import");
        (0, vitest_1.expect)((0, classifyPatchIntent_js_1.classifyPatchIntent)("add comment and replace text")).toBe("add_comment");
    });
});
//# sourceMappingURL=classifyPatchIntent.test.js.map