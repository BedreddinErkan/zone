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
vitest_1.vi.mock("../repo/scanRepo.js", () => ({
    scanRepo: scanRepoMock,
}));
vitest_1.vi.mock("./testOutputValidator.js", () => ({
    validateTestOutput: validateTestOutputMock,
}));
vitest_1.vi.mock("../repo/readProjectFiles.js", () => ({
    readProjectFiles: readProjectFilesMock,
}));
vitest_1.vi.mock("./detectTestFramework.js", () => ({
    detectTestFramework: detectTestFrameworkMock,
}));
vitest_1.vi.mock("./testEngineerContext.js", () => ({
    buildTestEngineerContext: buildTestEngineerContextMock,
}));
vitest_1.vi.mock("../prompts/testEngineerPrompt.js", () => ({
    buildTestEngineerPrompt: buildTestEngineerPromptMock,
}));
vitest_1.vi.mock("../llm/openaiClient.js", () => ({
    createOpenAIClient: createMock,
    getModelName: getModelNameMock,
}));
vitest_1.vi.mock("../core/confidenceGate.js", () => ({
    checkConfidenceGate: checkConfidenceGateMock,
}));
vitest_1.vi.mock("./detectTestComplexity.js", () => ({
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
(0, vitest_1.describe)("runTestEngineerFlow", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.resetModules();
        vitest_1.vi.clearAllMocks();
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
    (0, vitest_1.it)("defaults missing confidence to the shared test engineer threshold", async () => {
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
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
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
                }),
            },
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
                stepDefinition: "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
            },
        });
        buildTestEngineerPromptMock.mockReturnValue("prompt");
        createMock.mockReturnValue(client);
        getModelNameMock.mockReturnValue("test-model");
        checkConfidenceGateMock.mockReturnValue({ pass: true });
        const logSpy = vitest_1.vi.spyOn(console, "log").mockImplementation(() => { });
        const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
        const result = await runTestEngineerFlow({
            task: "Write a new Cucumber scenario for round trip flight search",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.confidence).toBe(50);
        }
        (0, vitest_1.expect)(checkConfidenceGateMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            confidenceScore: 50,
            role: "test_engineer",
        }));
        (0, vitest_1.expect)(logSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
    });
    (0, vitest_1.it)("reads only the bounded number of example files for the prompt", async () => {
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
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
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
                }),
            },
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
                stepDefinition: "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
            },
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`])));
        buildTestEngineerPromptMock.mockReturnValue("prompt");
        createMock.mockReturnValue(client);
        getModelNameMock.mockReturnValue("test-model");
        checkConfidenceGateMock.mockReturnValue({ pass: true });
        const { runTestEngineerFlow } = await import("./runTestEngineerFlow.js");
        const result = await runTestEngineerFlow({
            task: "Write a new Cucumber scenario for round trip flight search",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        (0, vitest_1.expect)(readProjectFilesMock).toHaveBeenCalledTimes(4);
        (0, vitest_1.expect)(readProjectFilesMock).toHaveBeenNthCalledWith(1, files.slice(0, 3).map((file) => file.absolutePath));
        (0, vitest_1.expect)(readProjectFilesMock).toHaveBeenNthCalledWith(2, files.slice(4, 6).map((file) => file.absolutePath));
        (0, vitest_1.expect)(readProjectFilesMock).toHaveBeenNthCalledWith(3, files.slice(7, 10).map((file) => file.absolutePath));
        (0, vitest_1.expect)(readProjectFilesMock).toHaveBeenNthCalledWith(4, files.slice(10, 13).map((file) => file.absolutePath));
    });
    (0, vitest_1.it)("prioritizes richer cucumber feature examples before weaker ones", async () => {
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
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
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
                }),
            },
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
                stepDefinition: "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
            },
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => {
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
        })));
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
        (0, vitest_1.expect)(promptInput.featureContents.map((file) => file.path)).toEqual([
            "src/test/resources/features/rich.feature",
            "src/test/resources/features/generic.feature",
        ]);
    });
    (0, vitest_1.it)("keeps fallback ordering when no richer cucumber feature examples exist", async () => {
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
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
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
                }),
            },
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
                stepDefinition: "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
            },
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [filePath, "Feature: Plain\nScenario: Basic"])));
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
        (0, vitest_1.expect)(promptInput.featureContents.map((file) => file.path)).toEqual([
            "src/test/resources/features/a.feature",
            "src/test/resources/features/b.feature",
        ]);
    });
    (0, vitest_1.it)("includes complexity in the successful flow result", async () => {
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
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
                        summary: "Generated test",
                        warnings: [],
                        confidence: 82,
                        testFile: {
                            path: "tests/login.spec.ts",
                            content: "test('login', async ({ page }) => { await page.goto('/'); });",
                        },
                    }),
                }),
            },
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
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.complexity).toBe("e2e");
            (0, vitest_1.expect)(result.decisionMode).toBe("safe_to_apply");
        }
        (0, vitest_1.expect)(validateTestOutputMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            complexityHint: "e2e",
        }));
    });
    (0, vitest_1.it)("uses deterministic output paths instead of suspicious model-provided test filenames", async () => {
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
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
                        summary: "Generated login test",
                        warnings: [],
                        confidence: 82,
                        testFile: {
                            path: "tests/you_are_code_agent_analyze.spec.ts",
                            content: "test('login', async ({ page }) => { await page.goto('/'); expect(true).toBe(true); });",
                        },
                    }),
                }),
            },
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
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches[0]?.filePath).toBe("tests/login.spec.ts");
            (0, vitest_1.expect)(result.preview).toContain("tests/login.spec.ts");
            (0, vitest_1.expect)(result.preview).not.toContain("you_are_code_agent_analyze.spec.ts");
            (0, vitest_1.expect)(result.debug).toEqual(vitest_1.expect.objectContaining({
                selectedRole: "test_engineer",
                promptPipeline: "buildTestEngineerPrompt",
                finalPromptBuilder: "buildFinalPrompt",
                detectedFramework: "playwright_ts",
                frameworkAugmentation: "playwright",
                outputPathDecision: vitest_1.expect.objectContaining({
                    finalTestFilePath: "tests/login.spec.ts",
                    finalPathSource: "deterministic_context_override",
                    rawModelTestFilePath: "tests/you_are_code_agent_analyze.spec.ts",
                    rawModelPathDiffers: true,
                }),
                suspiciousFilenameFiltering: vitest_1.expect.objectContaining({
                    triggered: false,
                    generatedSlug: "login",
                    safeSlug: "login",
                }),
            }));
        }
    });
    (0, vitest_1.it)("caps confidence below 100 when non-blocking warnings are present", async () => {
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
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
                        summary: "Generated login test",
                        warnings: ["Selector may be brittle but still repository-native"],
                        confidence: 100,
                        testFile: {
                            path: "tests/login.spec.ts",
                            content: "test('login', async ({ page }) => { await page.goto('/login'); });",
                        },
                    }),
                }),
            },
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
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.confidence).toBe(95);
            (0, vitest_1.expect)(result.decisionMode).toBe("safe_to_apply");
            (0, vitest_1.expect)(result.warnings).toEqual(["Selector may be brittle but still repository-native"]);
        }
    });
    (0, vitest_1.it)("applies an additional confidence reduction for placeholder selector warnings", async () => {
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
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
                        summary: "Generated login test",
                        warnings: ["Placeholder selector was used for the submit button"],
                        confidence: 100,
                        testFile: {
                            path: "tests/login.spec.ts",
                            content: "test('login', async ({ page }) => { await page.goto('/login'); });",
                        },
                    }),
                }),
            },
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
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.confidence).toBe(80);
            (0, vitest_1.expect)(result.decisionMode).toBe("safe_to_apply");
        }
    });
    (0, vitest_1.it)("blocks arbitrary Playwright URL assertions when repository route evidence is missing", async () => {
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
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
                        summary: "Generated login test",
                        warnings: [],
                        confidence: 82,
                        testFile: {
                            path: "tests/login.spec.ts",
                            content: "test('login', async ({ page }) => { await expect(page).toHaveURL(/.*\\/#/); await expect(page.getByText('Invalid credentials')).toBeVisible(); });",
                        },
                    }),
                }),
            },
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
            "C:/repo/tests/login.spec.ts": "test('login page loads', async ({ page }) => { await page.goto('/login'); await expect(page.getByRole('heading')).toBeVisible(); });",
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
        (0, vitest_1.expect)(result).toEqual(vitest_1.expect.objectContaining({
            ok: false,
            framework: "playwright_ts",
            language: "typescript",
            confidence: 35,
            decisionMode: "blocked",
            validationBlocked: true,
            reason: "Output validation blocked: Generated Playwright URL assertion uses an arbitrary regex pattern instead of a repository-evidenced route.",
            preview: vitest_1.expect.stringContaining("Files to create:\n- tests/login.spec.ts"),
            applyPatches: [
                {
                    filePath: "tests/login.spec.ts",
                    fullContent: "test('login', async ({ page }) => { await expect(page).toHaveURL(/.*\\/#/); await expect(page.getByText('Invalid credentials')).toBeVisible(); });",
                },
            ],
            debug: vitest_1.expect.objectContaining({
                selectedRole: "test_engineer",
                detectedFramework: "playwright_ts",
                contextSelection: vitest_1.expect.objectContaining({
                    chosenExistingTestFile: "tests/login.spec.ts",
                }),
                outputPathDecision: vitest_1.expect.objectContaining({
                    rawModelTestFilePath: "tests/login.spec.ts",
                    finalTestFilePath: "tests/login.spec.ts",
                    finalPathSource: "deterministic_context",
                    rawModelPathDiffers: false,
                }),
                playwrightUrlAssertionGuard: vitest_1.expect.objectContaining({
                    checked: true,
                    triggered: true,
                    reason: "Generated Playwright URL assertion uses an arbitrary regex pattern instead of a repository-evidenced route.",
                    routeEvidence: ["/login"],
                }),
            }),
        }));
    });
});
//# sourceMappingURL=runTestEngineerFlow.test.js.map