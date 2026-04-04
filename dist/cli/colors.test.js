"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const colors_js_1 = require("./colors.js");
(0, vitest_1.describe)("cli colors", () => {
    (0, vitest_1.it)("colorize wraps text with ansi codes and reset", () => {
        (0, vitest_1.expect)((0, colors_js_1.colorize)("Zone", colors_js_1.c.bold, colors_js_1.c.orange)).toBe(`${colors_js_1.c.bold}${colors_js_1.c.orange}Zone${colors_js_1.c.reset}`);
    });
    (0, vitest_1.it)("badge wraps padded text with bold and color", () => {
        (0, vitest_1.expect)((0, colors_js_1.badge)("READY", colors_js_1.c.bgGreen)).toBe(`${colors_js_1.c.bold}${colors_js_1.c.bgGreen} READY ${colors_js_1.c.reset}`);
    });
});
//# sourceMappingURL=colors.test.js.map