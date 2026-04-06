"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runLlmPatchFlow_js_1 = require("../runLlmPatchFlow.js");
function buildLargeFile() {
    const lines = [
        'import { api } from "./api";',
        'import { render } from "./render";',
        "",
        "const APP = 'Zone';",
        "const VERSION = '0.5.0';",
        "",
        "export function bootstrap() {",
        "  return APP + VERSION;",
        "}",
        "",
    ];
    for (let i = 0; i < 80; i += 1) {
        lines.push(`function fillerBlock${i}() {`, `  const value${i} = "line-${i}".repeat(6);`, `  return value${i};`, "}", "");
    }
    lines.push("export async function updateExecuteButtonColor() {", "  const executeButton = document.querySelector('.exec-btn');", "  const helperText = 'change execute button color safely'.repeat(12);", "  if (executeButton) {", "    executeButton.setAttribute('data-tone', helperText);", "  }", "  return helperText;", "}", "");
    for (let i = 80; i < 160; i += 1) {
        lines.push(`function trailingBlock${i}() {`, `  const trailing${i} = "tail-${i}".repeat(6);`, `  return trailing${i};`, "}", "");
    }
    return lines.join("\n");
}
(0, vitest_1.describe)("smartContextWindow", () => {
    (0, vitest_1.it)("returns full content for files under 8000 chars", () => {
        const content = [
            "import { api } from './api';",
            "",
            "export function run() {",
            "  return api();",
            "}",
        ].join("\n");
        const result = (0, runLlmPatchFlow_js_1.smartContextWindow)({
            fileContent: content,
            task: "update run function",
        });
        (0, vitest_1.expect)(result.snippet).toBe(content);
        (0, vitest_1.expect)(result.isTruncated).toBe(false);
        (0, vitest_1.expect)(result.startLine).toBe(1);
        (0, vitest_1.expect)(result.endLine).toBe(5);
    });
    (0, vitest_1.it)("truncates large files and keeps snippet under maxChars", () => {
        const content = buildLargeFile();
        const result = (0, runLlmPatchFlow_js_1.smartContextWindow)({
            fileContent: content,
            task: "change execute button color",
            maxChars: 6000,
        });
        (0, vitest_1.expect)(result.isTruncated).toBe(true);
        (0, vitest_1.expect)(result.snippet.length).toBeLessThanOrEqual(6000);
    });
    (0, vitest_1.it)("includes the task-matching function in the snippet", () => {
        const content = buildLargeFile();
        const result = (0, runLlmPatchFlow_js_1.smartContextWindow)({
            fileContent: content,
            task: "change execute button color",
            maxChars: 6000,
        });
        (0, vitest_1.expect)(result.snippet).toContain("updateExecuteButtonColor");
        (0, vitest_1.expect)(result.snippet).toContain("executeButton");
    });
    (0, vitest_1.it)("never cuts mid-function and respects anchor boundaries", () => {
        const content = buildLargeFile();
        const result = (0, runLlmPatchFlow_js_1.smartContextWindow)({
            fileContent: content,
            task: "change execute button color",
            maxChars: 6000,
        });
        (0, vitest_1.expect)(result.snippet).toContain("export async function updateExecuteButtonColor() {");
        (0, vitest_1.expect)(result.snippet).toContain("  return helperText;");
        (0, vitest_1.expect)(result.snippet).toContain("}");
    });
    (0, vitest_1.it)("always includes the first 10 lines of the file", () => {
        const content = buildLargeFile();
        const firstTenLines = content.split("\n").slice(0, 10).join("\n");
        const result = (0, runLlmPatchFlow_js_1.smartContextWindow)({
            fileContent: content,
            task: "change execute button color",
            maxChars: 6000,
        });
        (0, vitest_1.expect)(result.snippet.startsWith(firstTenLines)).toBe(true);
    });
});
//# sourceMappingURL=smartContextWindow.test.js.map