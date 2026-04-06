"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildFinalPrompt_js_1 = require("./buildFinalPrompt.js");
(0, vitest_1.describe)("buildFinalPrompt", () => {
    (0, vitest_1.it)("always includes the global prompt", () => {
        const prompt = (0, buildFinalPrompt_js_1.buildFinalPrompt)({
            role: "developer",
            task: "polish spacing",
            context: "CONTEXT BLOCK",
        });
        (0, vitest_1.expect)(prompt).toContain("GLOBAL RULES");
        (0, vitest_1.expect)(prompt).toContain("Never generate filenames from raw user task text.");
    });
    (0, vitest_1.it)("selects the correct role prompt", () => {
        const prompt = (0, buildFinalPrompt_js_1.buildFinalPrompt)({
            role: "data_analyst",
            task: "create orders table",
            context: "CONTEXT BLOCK",
        });
        (0, vitest_1.expect)(prompt).toContain("Inspect schema, existing queries, and migration style before proposing changes.");
        (0, vitest_1.expect)(prompt).not.toContain("Inspect existing tests first");
    });
    (0, vitest_1.it)("adds the relevant framework prompt only for matching test flows", () => {
        const prompt = (0, buildFinalPrompt_js_1.buildFinalPrompt)({
            role: "test_engineer",
            task: "add login coverage",
            detectedFramework: "playwright_ts",
            context: "CONTEXT BLOCK",
        });
        (0, vitest_1.expect)(prompt).toContain("FRAMEWORK AUGMENTATION");
        (0, vitest_1.expect)(prompt).toContain("Reuse page objects, helpers, and fixtures when they exist.");
        (0, vitest_1.expect)(prompt).not.toContain("Preserve Cypress idioms");
    });
    (0, vitest_1.it)("does not add unrelated framework prompts", () => {
        const prompt = (0, buildFinalPrompt_js_1.buildFinalPrompt)({
            role: "developer",
            task: "fix login route",
            detectedFramework: "playwright_ts",
            context: "CONTEXT BLOCK",
        });
        (0, vitest_1.expect)(prompt).not.toContain("Reuse page objects, helpers, and fixtures when they exist.");
    });
    (0, vitest_1.it)("assembles deterministically", () => {
        const input = {
            role: "test_engineer",
            task: "add login coverage",
            detectedFramework: "cucumber_java",
            context: "CONTEXT BLOCK",
        };
        (0, vitest_1.expect)((0, buildFinalPrompt_js_1.buildFinalPrompt)(input)).toBe((0, buildFinalPrompt_js_1.buildFinalPrompt)(input));
    });
    (0, vitest_1.it)("keeps the filename guard text in final prompt for test roles", () => {
        const prompt = (0, buildFinalPrompt_js_1.buildFinalPrompt)({
            role: "test_engineer",
            task: "add negative login test",
            detectedFramework: "playwright_ts",
            context: "CONTEXT BLOCK",
        });
        (0, vitest_1.expect)(prompt).toContain("Never generate filenames from raw user task text.");
    });
});
//# sourceMappingURL=buildFinalPrompt.test.js.map