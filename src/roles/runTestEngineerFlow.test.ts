import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../types/project.js";

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
vi.mock("../repo/scanRepo.js", () => ({
  scanRepo: scanRepoMock,
}));
vi.mock("./testOutputValidator.js", () => ({
  validateTestOutput: validateTestOutputMock,
}));
vi.mock("../repo/readProjectFiles.js", () => ({
  readProjectFiles: readProjectFilesMock,
}));

vi.mock("./detectTestFramework.js", () => ({
  detectTestFramework: detectTestFrameworkMock,
}));

vi.mock("./testEngineerContext.js", () => ({
  buildTestEngineerContext: buildTestEngineerContextMock,
}));

vi.mock("../prompts/testEngineerPrompt.js", () => ({
  buildTestEngineerPrompt: buildTestEngineerPromptMock,
}));

vi.mock("../llm/openaiClient.js", () => ({
  createOpenAIClient: createMock,
  getModelName: getModelNameMock,
}));

vi.mock("../llm/factory.js", () => ({
  createLLMClient: createMock,
}));

vi.mock("../core/confidenceGate.js", () => ({
  checkConfidenceGate: checkConfidenceGateMock,
}));
vi.mock("./detectTestComplexity.js", () => ({
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

describe("runTestEngineerFlow", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
  });

  it("defaults missing confidence to the shared test engineer threshold", async () => {
    const files = [buildRepoFile("pom.xml")];
    const framework = {
      framework: "cucumber_java",
      confidence: "high",
      language: "java",
      evidence: ["pom.xml"],
      testFilePattern: "*.feature",
      testDir: "src/test/resources/features",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated test",
            warnings: [],
            featureFile: {
              path: "src/test/resources/features/round_trip_flight_search.feature",
              content: "Feature: Round trip flight search",
            },
            stepDefinitionFile: {
              path: "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
              content: "public class RoundTripFlightSearchSteps {}",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
      framework,
      existingTestFiles: [],
      pageObjectFiles: [],
      stepDefinitionFiles: [],
      featureFiles: [],
      configFiles: [],
      frameworkSummary: "Test framework: cucumber_java",
      promptRole: "Test engineer",
      outputRules: [],
      fileLocationRules: [],
      outputPaths: {
        testFile: "src/test/resources/features/round_trip_flight_search.feature",
        featureFile: "src/test/resources/features/round_trip_flight_search.feature",
        stepDefinition:
          "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
      },
    });
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Write a new Cucumber scenario for round trip flight search",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confidence).toBe(50);
    }
    expect(checkConfidenceGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confidenceScore: 50,
        role: "test_engineer",
      })
    );
const unexpectedLogs = logSpy.mock.calls.filter(
  (args) => !String(args[0]).startsWith("[zone-api]")
);
expect(unexpectedLogs).toHaveLength(0);    logSpy.mockRestore();
  });

  it("reads only the bounded number of example files for the prompt", async () => {
    const files = [
      buildRepoFile("src/main/java/com/enuygun/pages/HomePage.java"),
      buildRepoFile("src/main/java/com/enuygun/pages/ResultsPage.java"),
      buildRepoFile("src/main/java/com/enuygun/pages/BookingPage.java"),
      buildRepoFile("src/main/java/com/enuygun/pages/ExtraPage.java"),
      buildRepoFile("src/test/java/com/enuygun/stepdefinitions/FlightSearchSteps.java"),
      buildRepoFile("src/test/java/com/enuygun/stepdefinitions/BookingSteps.java"),
      buildRepoFile("src/test/java/com/enuygun/stepdefinitions/ExtraSteps.java"),
      buildRepoFile("src/test/resources/features/flight_search.feature"),
      buildRepoFile("src/test/resources/features/booking.feature"),
      buildRepoFile("src/test/resources/features/extra.feature"),
      buildRepoFile("src/test/java/com/enuygun/SmokeTest.java"),
      buildRepoFile("src/test/java/com/enuygun/LoginTest.java"),
      buildRepoFile("src/test/java/com/enuygun/CheckoutTest.java"),
      buildRepoFile("src/test/java/com/enuygun/OverflowTest.java"),
    ];
    const framework = {
      framework: "cucumber_java",
      confidence: "high",
      language: "java",
      evidence: ["pom.xml"],
      testFilePattern: "*.feature",
      testDir: "src/test/resources/features",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated test",
            warnings: [],
            confidence: 75,
            featureFile: {
              path: "src/test/resources/features/round_trip_flight_search.feature",
              content: "Feature: Round trip flight search",
            },
            stepDefinitionFile: {
              path: "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
              content: "public class RoundTripFlightSearchSteps {}",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
      framework,
      existingTestFiles: files.slice(10, 14),
      pageObjectFiles: files.slice(0, 4),
      stepDefinitionFiles: files.slice(4, 7),
      featureFiles: files.slice(7, 10),
      configFiles: [],
      frameworkSummary: "Test framework: cucumber_java",
      promptRole: "Test engineer",
      outputRules: [],
      fileLocationRules: [],
      outputPaths: {
        testFile: "src/test/resources/features/round_trip_flight_search.feature",
        featureFile: "src/test/resources/features/round_trip_flight_search.feature",
        stepDefinition:
          "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
      },
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Write a new Cucumber scenario for round trip flight search",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(readProjectFilesMock).toHaveBeenCalledTimes(4);
    expect(readProjectFilesMock).toHaveBeenNthCalledWith(
      1,
      files.slice(0, 3).map((file) => file.absolutePath)
    );
    expect(readProjectFilesMock).toHaveBeenNthCalledWith(
      2,
      files.slice(4, 6).map((file) => file.absolutePath)
    );
    expect(readProjectFilesMock).toHaveBeenNthCalledWith(
      3,
      files.slice(7, 10).map((file) => file.absolutePath)
    );
    expect(readProjectFilesMock).toHaveBeenNthCalledWith(
      4,
      files.slice(10, 13).map((file) => file.absolutePath)
    );
  });

  it("prioritizes richer cucumber feature examples before weaker ones", async () => {
    const files = [
      buildRepoFile("src/test/resources/features/generic.feature"),
      buildRepoFile("src/test/resources/features/rich.feature"),
      buildRepoFile("src/test/resources/features/secondary.feature"),
      buildRepoFile("features/fallback.feature"),
    ];
    const framework = {
      framework: "cucumber_java",
      confidence: "high",
      language: "java",
      evidence: ["pom.xml"],
      testFilePattern: "*.feature",
      testDir: "src/test/resources/features",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated test",
            warnings: [],
            confidence: 75,
            featureFile: {
              path: "src/test/resources/features/round_trip_flight_search.feature",
              content: "Feature: Round trip flight search",
            },
            stepDefinitionFile: {
              path: "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
              content: "public class RoundTripFlightSearchSteps {}",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
      framework,
      existingTestFiles: [],
      pageObjectFiles: [],
      stepDefinitionFiles: [],
      featureFiles: files,
      configFiles: [],
      frameworkSummary: "Test framework: cucumber_java",
      promptRole: "Test engineer",
      outputRules: [],
      fileLocationRules: [],
      outputPaths: {
        testFile: "src/test/resources/features/round_trip_flight_search.feature",
        featureFile: "src/test/resources/features/round_trip_flight_search.feature",
        stepDefinition:
          "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
      },
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => {
          if (filePath.endsWith("rich.feature")) {
            return [
              filePath,
              "Feature: Enuygun flight search\n@ui\nScenario Outline: Rich example\nExamples:\n| a |",
            ];
          }
          if (filePath.endsWith("secondary.feature")) {
            return [filePath, "Feature: Secondary\nScenario: Plain flow"];
          }
          if (filePath.endsWith("generic.feature")) {
            return [filePath, "Feature: Generic\nScenario: Basic flow"];
          }
          return [filePath, "Feature: Fallback\nScenario: Fallback flow"];
        })
      )
    );
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    await runTestEngineerFlow({
      task: "Write a new Cucumber scenario for round trip flight search",
      repoPath: "C:/repo",
    });

    const promptInput = buildTestEngineerPromptMock.mock.calls[0][0];
    expect(promptInput.featureContents.map((file: { path: string }) => file.path)).toEqual([
      "src/test/resources/features/rich.feature",
      "src/test/resources/features/generic.feature",
    ]);
  });

  it("keeps fallback ordering when no richer cucumber feature examples exist", async () => {
    const files = [
      buildRepoFile("src/test/resources/features/a.feature"),
      buildRepoFile("src/test/resources/features/b.feature"),
      buildRepoFile("features/c.feature"),
    ];
    const framework = {
      framework: "cucumber_java",
      confidence: "high",
      language: "java",
      evidence: ["pom.xml"],
      testFilePattern: "*.feature",
      testDir: "src/test/resources/features",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated test",
            warnings: [],
            confidence: 75,
            featureFile: {
              path: "src/test/resources/features/round_trip_flight_search.feature",
              content: "Feature: Round trip flight search",
            },
            stepDefinitionFile: {
              path: "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
              content: "public class RoundTripFlightSearchSteps {}",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
      framework,
      existingTestFiles: [],
      pageObjectFiles: [],
      stepDefinitionFiles: [],
      featureFiles: files,
      configFiles: [],
      frameworkSummary: "Test framework: cucumber_java",
      promptRole: "Test engineer",
      outputRules: [],
      fileLocationRules: [],
      outputPaths: {
        testFile: "src/test/resources/features/round_trip_flight_search.feature",
        featureFile: "src/test/resources/features/round_trip_flight_search.feature",
        stepDefinition:
          "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
      },
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, "Feature: Plain\nScenario: Basic"]))
    );
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    await runTestEngineerFlow({
      task: "Write a new Cucumber scenario for round trip flight search",
      repoPath: "C:/repo",
    });

    const promptInput = buildTestEngineerPromptMock.mock.calls[0][0];
    expect(promptInput.featureContents.map((file: { path: string }) => file.path)).toEqual([
      "src/test/resources/features/a.feature",
      "src/test/resources/features/b.feature",
    ]);
  });

  it("includes complexity in the successful flow result", async () => {
    const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
    const framework = {
      framework: "playwright_ts",
      confidence: "high",
      language: "typescript",
      evidence: ["playwright.config.ts"],
      testFilePattern: "*.spec.ts",
      testDir: "tests",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated test",
            warnings: [],
            confidence: 82,
            testFile: {
              path: "tests/login.spec.ts",
              content: "test('login', async ({ page }) => { await page.goto('/'); });",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
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
      debug: {
        selectedRole: "test_engineer",
        normalizedTask: "add a negative login test",
        intentTokens: ["login"],
        hasLoginIntent: true,
        loginSubIntent: "invalid_credentials",
        preferredBasenameToken: "login",
        candidateTestFiles: [
          {
            path: "tests/login.spec.ts",
            baseScore: 2,
            authPreferenceScore: 12,
            totalScore: 14,
          },
        ],
        chosenExistingTestFile: "tests/login.spec.ts",
        generatedSlug: "login",
        safeSlug: "login",
        suspiciousFilenameRejected: false,
        fallbackTestFilePath: "tests/login.spec.ts",
        finalOutputPath: "tests/login.spec.ts",
        finalOutputPathSource: "existing_test_file",
      },
    });
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });
    detectTestComplexityMock.mockReturnValue({
      complexity: "e2e",
      hints: ["Task requires chaining multiple page objects and steps"],
      suggestedPatterns: ["multiple page objects"],
    });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Write an end to end login flow",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.complexity).toBe("e2e");
      expect(result.decisionMode).toBe("safe_to_apply");
    }
    expect(validateTestOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        complexityHint: "e2e",
      })
    );
  });

  it("returns fileDiffs for generated test patches", async () => {
    const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
    const framework = {
      framework: "playwright_ts",
      confidence: "high",
      language: "typescript",
      evidence: ["playwright.config.ts"],
      testFilePattern: "*.spec.ts",
      testDir: "tests",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated test",
            warnings: [],
            confidence: 82,
            testFile: {
              path: "tests/login.spec.ts",
              content:
                "import { test } from '@playwright/test';\n\ntest('login', async () => {});\n\ntest('invalid credentials', async () => {});",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
      framework,
      existingTestFiles: [files[1]],
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
    });
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/tests/login.spec.ts":
        "import { test } from '@playwright/test';\n\ntest('login', async () => {});",
    });
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Add an invalid credentials login test",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          filePath: "tests/login.spec.ts",
          addedLines: 2,
          removedLines: 0,
          diff: expect.arrayContaining([
            expect.objectContaining({
              type: "added",
              content: "test('invalid credentials', async () => {});",
            }),
          ]),
        }),
      ]);
    }
  });

  it("uses deterministic output paths instead of suspicious model-provided test filenames", async () => {
    const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
    const framework = {
      framework: "playwright_ts",
      confidence: "high",
      language: "typescript",
      evidence: ["playwright.config.ts"],
      testFilePattern: "*.spec.ts",
      testDir: "tests",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated login test",
            warnings: [],
            confidence: 82,
            testFile: {
              path: "tests/you_are_code_agent_analyze.spec.ts",
              content: "test('login', async ({ page }) => { await page.goto('/'); expect(true).toBe(true); });",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
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
      debug: {
        selectedRole: "test_engineer",
        normalizedTask: "add a negative login test",
        intentTokens: ["login"],
        hasLoginIntent: true,
        loginSubIntent: "invalid_credentials",
        preferredBasenameToken: "login",
        candidateTestFiles: [
          {
            path: "tests/login.spec.ts",
            baseScore: 2,
            authPreferenceScore: 12,
            totalScore: 14,
          },
        ],
        chosenExistingTestFile: "tests/login.spec.ts",
        generatedSlug: "login",
        safeSlug: "login",
        suspiciousFilenameRejected: false,
        fallbackTestFilePath: "tests/login.spec.ts",
        finalOutputPath: "tests/login.spec.ts",
        finalOutputPathSource: "existing_test_file",
      },
    });
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });
    detectTestComplexityMock.mockReturnValue({
      complexity: "negative",
      hints: ["Task requires an error path"],
      suggestedPatterns: ["negative path"],
    });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Add a negative login test",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches[0]?.filePath).toBe("tests/login.spec.ts");
      expect(result.preview).toContain("tests/login.spec.ts");
      expect(result.preview).not.toContain("you_are_code_agent_analyze.spec.ts");
      expect(result.debug).toEqual(
        expect.objectContaining({
          selectedRole: "test_engineer",
          promptPipeline: "buildTestEngineerPrompt",
          finalPromptBuilder: "buildFinalPrompt",
          detectedFramework: "playwright_ts",
          frameworkAugmentation: "playwright",
          outputPathDecision: expect.objectContaining({
            finalTestFilePath: "tests/login.spec.ts",
            finalPathSource: "deterministic_context_override",
            rawModelTestFilePath: "tests/you_are_code_agent_analyze.spec.ts",
            rawModelPathDiffers: true,
          }),
          suspiciousFilenameFiltering: expect.objectContaining({
            triggered: false,
            generatedSlug: "login",
            safeSlug: "login",
          }),
        })
      );
    }
  });

  it("caps confidence below 100 when non-blocking warnings are present", async () => {
    const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
    const framework = {
      framework: "playwright_ts",
      confidence: "high",
      language: "typescript",
      evidence: ["playwright.config.ts"],
      testFilePattern: "*.spec.ts",
      testDir: "tests",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated login test",
            warnings: ["Selector may be brittle but still repository-native"],
            confidence: 100,
            testFile: {
              path: "tests/login.spec.ts",
              content: "test('login', async ({ page }) => { await page.goto('/login'); });",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
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
      debug: {
        selectedRole: "test_engineer",
        normalizedTask: "add a login test",
        intentTokens: ["login"],
        hasLoginIntent: true,
        loginSubIntent: "general_login",
        preferredBasenameToken: "login",
        candidateTestFiles: [],
        chosenExistingTestFile: "tests/login.spec.ts",
        generatedSlug: "login",
        safeSlug: "login",
        suspiciousFilenameRejected: false,
        fallbackTestFilePath: "tests/login.spec.ts",
        finalOutputPath: "tests/login.spec.ts",
        finalOutputPathSource: "existing_test_file",
      },
    });
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });
    detectTestComplexityMock.mockReturnValue({
      complexity: "simple",
      hints: ["Single focused test case"],
      suggestedPatterns: ["single test function"],
    });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Add a login test",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confidence).toBe(80);
      expect(result.decisionMode).toBe("safe_to_apply");
      expect(result.warnings).toEqual(["Selector may be brittle but still repository-native"]);
    }
  });

  it("applies an additional confidence reduction for placeholder selector warnings", async () => {
    const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
    const framework = {
      framework: "playwright_ts",
      confidence: "high",
      language: "typescript",
      evidence: ["playwright.config.ts"],
      testFilePattern: "*.spec.ts",
      testDir: "tests",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated login test",
            warnings: ["Placeholder selector was used for the submit button"],
            confidence: 100,
            testFile: {
              path: "tests/login.spec.ts",
              content: "test('login', async ({ page }) => { await page.goto('/login'); });",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
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
      debug: {
        selectedRole: "test_engineer",
        normalizedTask: "add a login test",
        intentTokens: ["login"],
        hasLoginIntent: true,
        loginSubIntent: "general_login",
        preferredBasenameToken: "login",
        candidateTestFiles: [],
        chosenExistingTestFile: "tests/login.spec.ts",
        generatedSlug: "login",
        safeSlug: "login",
        suspiciousFilenameRejected: false,
        fallbackTestFilePath: "tests/login.spec.ts",
        finalOutputPath: "tests/login.spec.ts",
        finalOutputPathSource: "existing_test_file",
      },
    });
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Add a login test",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confidence).toBe(65);
      expect(result.decisionMode).toBe("preview_only");
    }
  });

  it("ignores placeholder selector warnings for known real selectors like #password", async () => {
    const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
    const framework = {
      framework: "playwright_ts",
      confidence: "high",
      language: "typescript",
      evidence: ["playwright.config.ts"],
      testFilePattern: "*.spec.ts",
      testDir: "tests",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated login test",
            warnings: [],
            confidence: 82,
            testFile: {
              path: "tests/login.spec.ts",
              content:
                "test('login', async ({ page }) => { await page.locator('#password').fill('secret'); await expect(page.locator('#password')).toBeVisible(); });",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
      framework,
      existingTestFiles: [files[1]],
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
    });
    validateTestOutputMock.mockReturnValue({
      decision: "preview_only",
      summary: "Validation warnings (1) - review before applying",
      issues: [
        {
          code: "PLAYWRIGHT_PLACEHOLDER_SELECTOR",
          severity: "warning",
          message: 'Placeholder selector or guidance detected: "#password"',
        },
      ],
    });
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Add a login test for password validation",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).not.toContain(
        '[PLAYWRIGHT_PLACEHOLDER_SELECTOR] Placeholder selector or guidance detected: "#password"'
      );
      expect(result.decisionMode).toBe("safe_to_apply");
    }
  });

  it("normalizes task-slug fallback filenames to concise repo-native names", async () => {
    const files = [buildRepoFile("playwright.config.ts")];
    const framework = {
      framework: "playwright_ts",
      confidence: "high",
      language: "typescript",
      evidence: ["playwright.config.ts"],
      testFilePattern: "*.spec.ts",
      testDir: "tests",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated checkout test",
            warnings: [],
            confidence: 82,
            testFile: {
              path: "tests/fix_bug.spec.ts",
              content: "test('checkout', async () => {});",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
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
        testFile: "tests/fix_checkout_bug.spec.ts",
      },
    });
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Fix checkout bug",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches[0]?.filePath).toBe("tests/checkout.spec.ts");
      expect(result.preview).toContain("tests/checkout.spec.ts");
      expect(result.preview).not.toContain("fix_checkout_bug.spec.ts");
    }
  });

  it("blocks arbitrary Playwright URL assertions when repository route evidence is missing", async () => {
    const files = [buildRepoFile("playwright.config.ts"), buildRepoFile("tests/login.spec.ts")];
    const framework = {
      framework: "playwright_ts",
      confidence: "high",
      language: "typescript",
      evidence: ["playwright.config.ts"],
      testFilePattern: "*.spec.ts",
      testDir: "tests",
    };
    const client = {
      provider: "openai" as const,
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
            summary: "Generated login test",
            warnings: [],
            confidence: 82,
            testFile: {
              path: "tests/login.spec.ts",
              content:
                "test('login', async ({ page }) => { await expect(page).toHaveURL(/.*\\/#/); await expect(page.getByText('Invalid credentials')).toBeVisible(); });",
            },
          }),
            },
          },
        ],
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };

    scanRepoMock.mockResolvedValue(files);
    detectTestFrameworkMock.mockReturnValue(framework);
    buildTestEngineerContextMock.mockReturnValue({
      framework,
      existingTestFiles: [files[1]],
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
      debug: {
        selectedRole: "test_engineer",
        normalizedTask: "add a negative login test",
        intentTokens: ["login"],
        hasLoginIntent: true,
        loginSubIntent: "invalid_credentials",
        preferredBasenameToken: "login",
        candidateTestFiles: [
          {
            path: "tests/login.spec.ts",
            baseScore: 2,
            authPreferenceScore: 12,
            totalScore: 14,
          },
        ],
        chosenExistingTestFile: "tests/login.spec.ts",
        generatedSlug: "login",
        safeSlug: "login",
        suspiciousFilenameRejected: false,
        fallbackTestFilePath: "tests/login.spec.ts",
        finalOutputPath: "tests/login.spec.ts",
        finalOutputPathSource: "existing_test_file",
      },
    });
    readProjectFilesMock.mockResolvedValue({
      "C:/repo/tests/login.spec.ts":
        "test('login page loads', async ({ page }) => { await page.goto('/login'); await expect(page.getByRole('heading')).toBeVisible(); });",
    });
    buildTestEngineerPromptMock.mockReturnValue("prompt");
    createMock.mockReturnValue(client);
    getModelNameMock.mockReturnValue("test-model");
    checkConfidenceGateMock.mockReturnValue({ pass: true });
    detectTestComplexityMock.mockReturnValue({
      complexity: "negative",
      hints: ["Task requires an error path"],
      suggestedPatterns: ["negative path"],
    });

    const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
    const result = await runTestEngineerFlow({
      task: "Add a negative login test",
      repoPath: "C:/repo",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        framework: "playwright_ts",
        language: "typescript",
        confidence: 35,
        decisionMode: "blocked",
        validationBlocked: true,
        reason:
          "Output validation blocked: Generated Playwright URL assertion uses an arbitrary regex pattern instead of a repository-evidenced route.",
        preview: expect.stringContaining("Files to create:\n- tests/login.spec.ts"),
        applyPatches: [
          {
            filePath: "tests/login.spec.ts",
            fullContent:
              "test('login', async ({ page }) => { await expect(page).toHaveURL(/.*\\/#/); await expect(page.getByText('Invalid credentials')).toBeVisible(); });",
          },
        ],
        debug: expect.objectContaining({
          selectedRole: "test_engineer",
          detectedFramework: "playwright_ts",
          contextSelection: expect.objectContaining({
            chosenExistingTestFile: "tests/login.spec.ts",
          }),
          outputPathDecision: expect.objectContaining({
            rawModelTestFilePath: "tests/login.spec.ts",
            finalTestFilePath: "tests/login.spec.ts",
            finalPathSource: "deterministic_context",
            rawModelPathDiffers: false,
          }),
          playwrightUrlAssertionGuard: expect.objectContaining({
            checked: true,
            triggered: true,
            reason:
              "Generated Playwright URL assertion uses an arbitrary regex pattern instead of a repository-evidenced route.",
            routeEvidence: ["/login"],
          }),
        }),
      })
    );
  });
});
