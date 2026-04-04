"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fullPatchPrompt_js_1 = require("./fullPatchPrompt.js");
const BASE_INPUT = {
    task: "Add a null check before calling process()",
    filePath: "src/core/processor.ts",
    fileContent: "export function process(input: string) { return input.trim(); }",
    repoSummary: "TypeScript monorepo with strict mode enabled.",
    relatedContext: "Called from src/cli/index.ts line 42.",
};
(0, vitest_1.describe)("buildFullPatchPrompt", () => {
    (0, vitest_1.it)("returns a non-empty string", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(typeof prompt).toBe("string");
        (0, vitest_1.expect)(prompt.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("includes the task", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain(BASE_INPUT.task);
    });
    (0, vitest_1.it)("includes the filePath", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain(BASE_INPUT.filePath);
    });
    (0, vitest_1.it)("includes the fileContent", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain(BASE_INPUT.fileContent);
    });
    (0, vitest_1.it)("includes the repoSummary", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain(BASE_INPUT.repoSummary);
    });
    (0, vitest_1.it)("includes the relatedContext", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain(BASE_INPUT.relatedContext);
    });
    (0, vitest_1.it)("includes the OUTPUT FORMAT JSON shape", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain('"filePath"');
        (0, vitest_1.expect)(prompt).toContain('"fullContent"');
        (0, vitest_1.expect)(prompt).toContain('"summary"');
        (0, vitest_1.expect)(prompt).toContain('"warnings"');
    });
    (0, vitest_1.it)("instructs to return COMPLETE updated file content", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain("COMPLETE updated file content");
    });
    (0, vitest_1.it)("instructs not to add markdown fences", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain("Do not add markdown fences");
    });
    (0, vitest_1.it)("instructs to preserve unrelated code", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain("Preserve all existing code that is unrelated");
    });
    (0, vitest_1.it)("supports find/replace patch mode for large files", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)({
            ...BASE_INPUT,
            outputMode: "find_replace_patch",
        });
        (0, vitest_1.expect)(prompt).toContain("Return ONLY the specific change as a FIND/REPLACE patch");
        (0, vitest_1.expect)(prompt).toContain("--- FIND ---");
        (0, vitest_1.expect)(prompt).toContain("--- REPLACE ---");
    });
    (0, vitest_1.it)("instructs to return JSON only", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain("Return JSON only");
    });
    (0, vitest_1.it)("output is deterministic — same input produces same output", () => {
        const a = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        const b = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(a).toBe(b);
    });
    (0, vitest_1.it)("different inputs produce different outputs", () => {
        const a = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        const b = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)({ ...BASE_INPUT, task: "Remove the process() call entirely" });
        (0, vitest_1.expect)(a).not.toBe(b);
    });
    (0, vitest_1.it)("file content is wrapped in code fences in the prompt", () => {
        const prompt = (0, fullPatchPrompt_js_1.buildFullPatchPrompt)(BASE_INPUT);
        (0, vitest_1.expect)(prompt).toContain("```");
        // content appears between the fences
        const fenceIdx = prompt.indexOf("```");
        const contentIdx = prompt.indexOf(BASE_INPUT.fileContent);
        (0, vitest_1.expect)(contentIdx).toBeGreaterThan(fenceIdx);
    });
});
//# sourceMappingURL=fullPatchPrompt.test.js.map