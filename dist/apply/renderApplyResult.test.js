"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const renderApplyResult_js_1 = require("./renderApplyResult.js");
(0, vitest_1.describe)("renderApplyResult", () => {
    (0, vitest_1.it)("renders a non-applied result clearly", () => {
        const result = {
            applied: false,
            filesChanged: [],
            summary: "Apply confirmation is required."
        };
        const output = (0, renderApplyResult_js_1.renderApplyResult)(result);
        (0, vitest_1.expect)(output).toContain("=== APPLY RESULT ===");
        (0, vitest_1.expect)(output).toContain("Applied: no");
        (0, vitest_1.expect)(output).toContain("Summary: Apply confirmation is required.");
        (0, vitest_1.expect)(output).not.toContain("Changed files:");
    });
    (0, vitest_1.it)("renders an applied result with changed files", () => {
        const result = {
            applied: true,
            filesChanged: ["src/core/foo.ts", "src/core/bar.ts"],
            summary: "Applied 2 file change(s)."
        };
        const output = (0, renderApplyResult_js_1.renderApplyResult)(result);
        (0, vitest_1.expect)(output).toContain("=== APPLY RESULT ===");
        (0, vitest_1.expect)(output).toContain("Applied: yes");
        (0, vitest_1.expect)(output).toContain("Summary: Applied 2 file change(s).");
        (0, vitest_1.expect)(output).toContain("Changed files:");
        (0, vitest_1.expect)(output).toContain("- src/core/foo.ts");
        (0, vitest_1.expect)(output).toContain("- src/core/bar.ts");
    });
    (0, vitest_1.it)("does not render changed files section when no files changed", () => {
        const result = {
            applied: true,
            filesChanged: [],
            summary: "Applied 0 file change(s)."
        };
        const output = (0, renderApplyResult_js_1.renderApplyResult)(result);
        (0, vitest_1.expect)(output).toContain("Applied: yes");
        (0, vitest_1.expect)(output).toContain("Summary: Applied 0 file change(s).");
        (0, vitest_1.expect)(output).not.toContain("Changed files:");
    });
});
//# sourceMappingURL=renderApplyResult.test.js.map