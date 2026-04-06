"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runLlmPatchFlow_js_1 = require("../runLlmPatchFlow.js");
(0, vitest_1.describe)("fuzzy match scoring", () => {
    (0, vitest_1.it)("returns score 100 for an exact match block", () => {
        const lines = [
            'const label = "Zone";',
            'const button = "Execute";',
        ].map(runLlmPatchFlow_js_1.normalizeLineForMatch);
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.scoreCandidateMatch)(lines, lines)).toBe(100);
    });
    (0, vitest_1.it)("keeps a high score for indentation-only differences", () => {
        const target = [
            "<body>",
            '  <button class="exec-btn">Execute</button>',
            "</body>",
        ].map(runLlmPatchFlow_js_1.normalizeLineForMatch);
        const candidate = [
            "<body>",
            '\t<button class="exec-btn">Execute</button>',
            "</body>",
        ].map(runLlmPatchFlow_js_1.normalizeLineForMatch);
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.scoreCandidateMatch)(target, candidate)).toBeGreaterThanOrEqual(85);
    });
    (0, vitest_1.it)("keeps a usable score when one variable name is renamed", () => {
        const target = [
            "function saveUser() {",
            "  const userName = input.name;",
            "  return userName;",
            "}",
        ].map(runLlmPatchFlow_js_1.normalizeLineForMatch);
        const candidate = [
            "function saveUser() {",
            "  const accountName = input.name;",
            "  return userName;",
            "}",
        ].map(runLlmPatchFlow_js_1.normalizeLineForMatch);
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.scoreCandidateMatch)(target, candidate)).toBeGreaterThanOrEqual(75);
    });
    (0, vitest_1.it)("returns a low score for a completely different block", () => {
        const target = [
            "<button>Execute</button>",
            "<div>Recent Runs</div>",
        ].map(runLlmPatchFlow_js_1.normalizeLineForMatch);
        const candidate = [
            "CREATE TABLE users (id INTEGER PRIMARY KEY);",
            "INSERT INTO users VALUES (1);",
        ].map(runLlmPatchFlow_js_1.normalizeLineForMatch);
        (0, vitest_1.expect)((0, runLlmPatchFlow_js_1.scoreCandidateMatch)(target, candidate)).toBeLessThan(80);
    });
    (0, vitest_1.it)("returns success false for an empty FIND block", () => {
        const result = (0, runLlmPatchFlow_js_1.fuzzyFindAndReplace)("<body>\n<button>Execute</button>\n</body>", "   \n\t  ", "<button>Run</button>");
        (0, vitest_1.expect)(result.success).toBe(false);
        if (!result.success) {
            (0, vitest_1.expect)(result.reason).toBe("low_confidence");
            (0, vitest_1.expect)(result.score).toBe(0);
        }
    });
});
//# sourceMappingURL=fuzzyMatch.test.js.map