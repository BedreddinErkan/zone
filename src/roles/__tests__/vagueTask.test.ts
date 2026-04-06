import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../../types/project.js";

const scanRepoMock = vi.fn();
const readProjectFilesMock = vi.fn();
const detectTestFrameworkMock = vi.fn();
const buildTestEngineerContextMock = vi.fn();
const buildTestEngineerPromptMock = vi.fn();
const createMock = vi.fn();
const getModelNameMock = vi.fn();
const checkConfidenceGateMock = vi.fn();
const validateTestOutputMock = vi.fn();
const detectTestComplexityMock = vi.fn();

vi.mock("../../repo/scanRepo.js", () => ({
  scanRepo: scanRepoMock,
}));

vi.mock("../testOutputValidator.js", () => ({
  validateTestOutput: validateTestOutputMock,
}));

vi.mock("../../repo/readProjectFiles.js", () => ({
  readProjectFiles: readProjectFilesMock,
}));

vi.mock("../detectTestFramework.js", () => ({
  detectTestFramework: detectTestFrameworkMock,
}));

vi.mock("../testEngineerContext.js", () => ({
  buildTestEngineerContext: buildTestEngineerContextMock,
}));

vi.mock("../../prompts/testEngineerPrompt.js", () => ({
  buildTestEngineerPrompt: buildTestEngineerPromptMock,
}));

vi.mock("../../llm/openaiClient.js", () => ({
  createOpenAIClient: createMock,
  getModelName: getModelNameMock,
}));

vi.mock("../../core/confidenceGate.js", () => ({
  checkConfidenceGate: checkConfidenceGateMock,
}));

vi.mock("../detectTestComplexity.js", () => ({
  detectTestComplexity: detectTestComplexityMock,
}));

function buildRepoFile(path: string): RepoFile {
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

function buildContext(framework: ReturnType<typeof buildFramework>) {
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

describe("runTestEngineerFlow vague task penalty", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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

  it("caps confidence at 60 and forces preview-only for vague tasks", async () => {
    const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
    const framework = buildFramework();
    const client = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            summary: "Generated login test",
            warnings: ["Existing warning"],
            confidence: 96,
            testFile: {
              path: "tests/login.spec.ts",
              content:
                "test('login', async ({ page }) => { await page.goto('/login'); await expect(page.getByText('Invalid credentials')).toBeVisible(); });",
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confidence).toBe(60);
      expect(result.decisionMode).toBe("preview_only");
      expect(result.warnings).toContain("Existing warning");
      expect(result.warnings).toContain(
        "[VAGUE_TASK] Task is too vague to generate a reliable test. Please describe the specific scenario, page, and expected behavior."
      );
    }
    expect(checkConfidenceGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confidenceScore: 60,
        warnings: expect.arrayContaining([
          "[VAGUE_TASK] Task is too vague to generate a reliable test. Please describe the specific scenario, page, and expected behavior.",
        ]),
      })
    );
  });

  it("keeps specific tasks eligible for safe_to_apply when confidence is high", async () => {
    const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
    const framework = buildFramework();
    const client = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            summary: "Generated login test",
            warnings: [],
            confidence: 82,
            testFile: {
              path: "tests/login.spec.ts",
              content:
                "test('invalid login', async ({ page }) => { await page.goto('/login'); await expect(page.getByText('Invalid credentials')).toBeVisible(); });",
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confidence).toBe(82);
      expect(result.decisionMode).toBe("safe_to_apply");
      expect(result.warnings).not.toContain(
        "[VAGUE_TASK] Task is too vague to generate a reliable test. Please describe the specific scenario, page, and expected behavior."
      );
    }
  });
});
