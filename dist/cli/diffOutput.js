"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderColoredDiff = renderColoredDiff;
exports.renderDiffSummary = renderDiffSummary;
const colors_js_1 = require("./colors.js");
function renderColoredDiff(originalContent, newContent, filePath) {
    const originalLines = originalContent.split("\n");
    const newLines = newContent.split("\n");
    const lines = [];
    lines.push((0, colors_js_1.colorize)(`--- ${filePath}`, colors_js_1.c.bold, colors_js_1.c.white));
    lines.push("");
    const maxLen = Math.max(originalLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
        const origLine = originalLines[i];
        const nextLine = newLines[i];
        if (origLine === nextLine) {
            if (nextLine !== undefined) {
                lines.push((0, colors_js_1.colorize)(`  ${nextLine}`, colors_js_1.c.dim, colors_js_1.c.gray));
            }
            continue;
        }
        if (origLine !== undefined) {
            lines.push((0, colors_js_1.colorize)(`- ${origLine}`, colors_js_1.c.red));
        }
        if (nextLine !== undefined) {
            lines.push((0, colors_js_1.colorize)(`+ ${nextLine}`, colors_js_1.c.green));
        }
    }
    return lines.join("\n");
}
function renderDiffSummary(applied) {
    for (const entry of applied) {
        console.log(renderColoredDiff(entry.original, entry.updated, entry.filePath));
        console.log("");
    }
}
//# sourceMappingURL=diffOutput.js.map