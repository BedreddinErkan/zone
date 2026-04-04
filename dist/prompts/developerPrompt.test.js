"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const developerPrompt_js_1 = require("./developerPrompt.js");
(0, vitest_1.describe)("buildDeveloperPrompt", () => {
    (0, vitest_1.it)("enforces existing-repo and minimal-diff behavior", () => {
        const prompt = (0, developerPrompt_js_1.buildDeveloperPrompt)({
            task: "small UI polish and readability improvements for src/ui/index.html",
            repoPath: "C:/repo",
            taskIntent: "ui polish",
            existingTargetFiles: ["src/ui/index.html"],
            targetFilePath: "src/ui/index.html",
            targetFileContent: '<div id="progressBox" class="progress-box"></div>',
            repoSummary: "Zone dark UI app.",
            relatedContext: "Keep patch preview readable.",
            relevantFiles: [
                {
                    path: "src/ui/index.html",
                    content: '<div id="patchSection" class="section"></div>',
                },
            ],
        });
        (0, vitest_1.expect)(prompt).toContain("real existing repository");
        (0, vitest_1.expect)(prompt).toContain("Keep the diff minimal and localized");
        (0, vitest_1.expect)(prompt).toContain("Modify existing files in place whenever possible");
        (0, vitest_1.expect)(prompt).toContain("return the file unchanged and add a warning");
    });
    (0, vitest_1.it)("includes anti-scaffold instructions for ui tasks", () => {
        const prompt = (0, developerPrompt_js_1.buildDeveloperPrompt)({
            task: "polish the existing UI page",
            repoPath: "C:/repo",
            taskIntent: "ui polish",
            existingTargetFiles: ["src/ui/index.html"],
            targetFilePath: "src/ui/index.html",
            targetFileContent: "<body><div id=\"app\"></div></body>",
            relevantFiles: [],
        });
        (0, vitest_1.expect)(prompt).toContain("Do NOT generate a full HTML page");
        (0, vitest_1.expect)(prompt).toContain("Welcome to My App");
        (0, vitest_1.expect)(prompt).toContain("Get Started");
        (0, vitest_1.expect)(prompt).toContain("Application Dashboard");
        (0, vitest_1.expect)(prompt).toContain("Do NOT replace the page with generic content");
    });
    (0, vitest_1.it)("includes relevant file context in the prompt", () => {
        const prompt = (0, developerPrompt_js_1.buildDeveloperPrompt)({
            task: "update auth route validation",
            repoPath: "C:/repo",
            taskIntent: "api backend",
            targetFilePath: "server/routes/auth.ts",
            targetFileContent: "router.post('/login', loginHandler);",
            relevantFiles: [
                {
                    path: "server/routes/auth.ts",
                    content: "router.post('/login', loginHandler);",
                },
                {
                    path: "server/middleware/session.ts",
                    content: "export function requireSession() {}",
                },
            ],
        });
        (0, vitest_1.expect)(prompt).toContain("RELEVANT REPOSITORY FILES");
        (0, vitest_1.expect)(prompt).toContain("FILE: server/routes/auth.ts");
        (0, vitest_1.expect)(prompt).toContain("FILE: server/middleware/session.ts");
    });
    (0, vitest_1.it)("includes micro-edit instructions for small ui tasks", () => {
        const prompt = (0, developerPrompt_js_1.buildDeveloperPrompt)({
            task: "small line-height and spacing polish for the existing UI",
            repoPath: "C:/repo",
            taskIntent: "ui polish",
            targetFilePath: "src/ui/index.html",
            targetFileContent: '<div class="content" style="line-height:1.5"></div>',
            relevantFiles: [
                {
                    path: "src/ui/index.html",
                    content: '<div class="content" style="line-height:1.5"></div>',
                },
            ],
        });
        (0, vitest_1.expect)(prompt).toContain("MICRO-EDIT MODE");
        (0, vitest_1.expect)(prompt).toContain("MUST prefer a tiny in-place edit");
        (0, vitest_1.expect)(prompt).toContain("Modify existing style, class, spacing, line-height");
        (0, vitest_1.expect)(prompt).toContain("Do NOT rewrite the page layout");
    });
    (0, vitest_1.it)("enforces patch-style output instead of full files", () => {
        const prompt = (0, developerPrompt_js_1.buildDeveloperPrompt)({
            task: "small spacing polish for existing UI",
            repoPath: "C:/repo",
            taskIntent: "ui polish",
            targetFilePath: "src/ui/index.html",
            targetFileContent: "<body></body>",
            relevantFiles: [],
        });
        (0, vitest_1.expect)(prompt).toContain("DO NOT output full file content");
        (0, vitest_1.expect)(prompt).toContain("ONLY output patch-style edits");
        (0, vitest_1.expect)(prompt).toContain('"patchText"');
        (0, vitest_1.expect)(prompt).toContain("FIND/REPLACE");
    });
});
//# sourceMappingURL=developerPrompt.test.js.map