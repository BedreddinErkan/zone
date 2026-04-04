"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const colors_js_1 = require("./colors.js");
const diffOutput_js_1 = require("./diffOutput.js");
(0, vitest_1.describe)("diffOutput", () => {
    (0, vitest_1.it)("renders added lines in green", () => {
        const output = (0, diffOutput_js_1.renderColoredDiff)("", "hello", "src/file.ts");
        (0, vitest_1.expect)(output).toContain(`${colors_js_1.c.green}+ hello${colors_js_1.c.reset}`);
    });
    (0, vitest_1.it)("renders removed lines in red", () => {
        const output = (0, diffOutput_js_1.renderColoredDiff)("hello", "", "src/file.ts");
        (0, vitest_1.expect)(output).toContain(`${colors_js_1.c.red}- hello${colors_js_1.c.reset}`);
    });
    (0, vitest_1.it)("renders unchanged lines in gray", () => {
        const output = (0, diffOutput_js_1.renderColoredDiff)("same", "same", "src/file.ts");
        (0, vitest_1.expect)(output).toContain(`${colors_js_1.c.dim}${colors_js_1.c.gray}  same${colors_js_1.c.reset}`);
    });
    (0, vitest_1.it)("handles empty original as all lines added", () => {
        const output = (0, diffOutput_js_1.renderColoredDiff)("", "a\nb", "src/file.ts");
        (0, vitest_1.expect)(output).toContain(`${colors_js_1.c.green}+ a${colors_js_1.c.reset}`);
        (0, vitest_1.expect)(output).toContain(`${colors_js_1.c.green}+ b${colors_js_1.c.reset}`);
    });
    (0, vitest_1.it)("handles empty new content as all lines removed", () => {
        const output = (0, diffOutput_js_1.renderColoredDiff)("a\nb", "", "src/file.ts");
        (0, vitest_1.expect)(output).toContain(`${colors_js_1.c.red}- a${colors_js_1.c.reset}`);
        (0, vitest_1.expect)(output).toContain(`${colors_js_1.c.red}- b${colors_js_1.c.reset}`);
    });
    (0, vitest_1.it)("shows file path in header", () => {
        const output = (0, diffOutput_js_1.renderColoredDiff)("a", "b", "src/file.ts");
        (0, vitest_1.expect)(output).toContain(`${colors_js_1.c.bold}${colors_js_1.c.white}--- src/file.ts${colors_js_1.c.reset}`);
    });
    (0, vitest_1.it)("prints all rendered diffs in renderDiffSummary", () => {
        const logSpy = vitest_1.vi.spyOn(console, "log").mockImplementation(() => { });
        (0, diffOutput_js_1.renderDiffSummary)([
            { filePath: "src/file.ts", original: "a", updated: "b" },
        ]);
        (0, vitest_1.expect)(logSpy).toHaveBeenCalled();
        logSpy.mockRestore();
    });
});
//# sourceMappingURL=diffOutput.test.js.map