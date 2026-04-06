"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const scanRepoMock = vitest_1.vi.fn();
const readProjectFilesMock = vitest_1.vi.fn();
const detectTestFrameworkMock = vitest_1.vi.fn();
const buildTestEngineerContextMock = vitest_1.vi.fn();
const buildTestEngineerPromptMock = vitest_1.vi.fn();
const createMock = vitest_1.vi.fn();
const getModelNameMock = vitest_1.vi.fn();
const checkConfidenceGateMock = vitest_1.vi.fn();
const validateTestOutputMock = vitest_1.vi.fn();
const detectTestComplexityMock = vitest_1.vi.fn();
vitest_1.vi.mock("../../repo/scanRepo.js", () => ({
    scanRepo: scanRepoMock,
}));
vitest_1.vi.mock("../testOutputValidator.js", () => ({
    validateTestOutput: validateTestOutputMock,
}));
vitest_1.vi.mock("../../repo/readProjectFiles.js", () => ({
    readProjectFiles: readProjectFilesMock,
}));
vitest_1.vi.mock("../detectTestFramework.js", () => ({
    detectTestFramework: detectTestFrameworkMock,
}));
vitest_1.vi.mock("../testEngineerContext.js", () => ({
    buildTestEngineerContext: buildTestEngineerContextMock,
}));
vitest_1.vi.mock("../../prompts/testEngineerPrompt.js", () => ({
    buildTestEngineerPrompt: buildTestEngineerPromptMock,
}));
vitest_1.vi.mock("../../llm/openaiClient.js", () => ({
    createOpenAIClient: createMock,
    getModelName: getModelNameMock,
}));
vitest_1.vi.mock("../../core/confidenceGate.js", () => ({
    checkConfidenceGate: checkConfidenceGateMock,
}));
vitest_1.vi.mock("../detectTestComplexity.js", () => ({
    detectTestComplexity: detectTestComplexityMock,
}));
function buildRepoFile(path) {
    return {
        path,
        absolutePath: `C:/repo/${path}`,
        extension: path.split(".").pop() ?? "",
        category: "unknown",
    };
}
function buildFramework() {
    return {
        framework: "playwright_ts",
        confidence: "high",
        language: "typescript",
        evidence: ["playwright.config.ts"],
        testFilePattern: "*.spec.ts",
        testDir: "tests",
    };
}
function buildContext(framework) {
    return {
        framework,
        existingTestFiles: [],
        pageObjectFiles: [],
        stepDefinitionFiles: [],
        featureFiles: [],
        configFiles: [],
        frameworkSummary: "Test framework: playwright_ts",
        promptRole: "Test engineer",
        outputRules: [],
        fileLocationRules: [],
        outputPaths: {
            testFile: "tests/login.spec.ts",
        },
    };
}
(0, vitest_1.describe)("runTestEngineerFlow vague task penalty", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.resetModules();
        vitest_1.vi.clearAllMocks();
        readProjectFilesMock.mockResolvedValue({});
        validateTestOutputMock.mockReturnValue({
            decision: "pass",
            issues: [],
            summary: "Validation passed",
        });
        detectTestComplexityMock.mockReturnValue({
            complexity: "simple",
            hints: ["Single focused test case"],
            suggestedPatterns: ["single test function"],
        });
        checkConfidenceGateMock.mockReturnValue({ pass: true });
        getModelNameMock.mockReturnValue("test-model");
    });
    (0, vitest_1.it)("caps confidence at 60 and forces preview-only for vague tasks", async () => {
        const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
        const framework = buildFramework();
        const client = {
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
                        summary: "Generated login test",
                        warnings: ["Existing warning"],
                        confidence: 96,
                        testFile: {
                            path: "tests/login.spec.ts",
                            content: "test('login', async ({ page }) => { await page.goto('/login'); await expect(page.getByText('Invalid credentials')).toBeVisible(); });",
                        },
                    }),
                }),
            },
        };
        scanRepoMock.mockResolvedValue(files);
        detectTestFrameworkMock.mockReturnValue(framework);
        buildTestEngineerContextMock.mockReturnValue(buildContext(framework));
        buildTestEngineerPromptMock.mockReturnValue("prompt");
        createMock.mockReturnValue(client);
        const { runTestEngineerFlow } = await import("../runTestEngineerFlow.js");
        const result = await runTestEngineerFlow({
            task: "write test",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.confidence).toBe(60);
            (0, vitest_1.expect)(result.decisionMode).toBe("preview_only");
            (0, vitest_1.expect)(result.warnings).toContain("Existing warning");
            (0, vitest_1.expect)(result.warnings).toContain("[VAGUE_TASK] Task is too vague to generate a reliable test. Please describe the specific scenario, page, and expected behavior.");
        }
        (0, vitest_1.expect)(checkConfidenceGateMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            confidenceScore: 60,
            warnings: vitest_1.expect.arrayContaining([
                "[VAGUE_TASK] Task is too vague to generate a reliable test. Please describe the specific scenario, page, and expected behavior.",
            ]),
        }));
    });
    (0, vitest_1.it)("keeps specific tasks eligible for safe_to_apply when confidence is high", async () => {
        const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
        const framework = buildFramework();
        const client = {
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
                        summary: "Generated login test",
                        warnings: [],
                        confidence: 82,
                        testFile: {
                            path: "tests/login.spec.ts",
                            content: "test('invalid login', async ({ page }) => { await page.goto('/login'); await expect(page.getByText('Invalid credentials')).toBeVisible(); });",
                        },
                    }),
                }),
            },
        };
        scanRepoMock.mockResolvedValue(files);
        detectTestFrameworkMock.mockReturnValue(framework);
        buildTestEngineerContextMock.mockReturnValue(buildContext(framework));
        buildTestEngineerPromptMock.mockReturnValue("prompt");
        createMock.mockReturnValue(client);
        const { runTestEngineerFlow } = await import("../runTestEngineerFlow.js");
        const result = await runTestEngineerFlow({
            task: "add a negative login test for invalid credentials",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.confidence).toBe(82);
            (0, vitest_1.expect)(result.decisionMode).toBe("safe_to_apply");
            (0, vitest_1.expect)(result.warnings).not.toContain("[VAGUE_TASK] Task is too vague to generate a reliable test. Please describe the specific scenario, page, and expected behavior.");
        }
    });
});
//# sourceMappingURL=vagueTask.test.js.map