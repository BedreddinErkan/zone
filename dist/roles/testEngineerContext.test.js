"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const testEngineerContext_js_1 = require("./testEngineerContext.js");
function buildFramework(overrides = {}) {
    return {
        framework: "cucumber_java",
        confidence: "high",
        language: "java",
        evidence: ["test"],
        testFilePattern: "*.feature",
        testDir: "src/test/resources/features",
        ...overrides,
    };
}
function buildRepoFile(path) {
    return {
        path,
        absolutePath: `C:/repo/${path}`,
        extension: path.split(".").pop() ?? "",
        category: "unknown",
    };
}
(0, vitest_1.describe)("buildTestEngineerContext output naming", () => {
    (0, vitest_1.it)("produces a concise cucumber feature slug from task intent", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Write a new Cucumber scenario for round trip flight search", buildFramework(), []);
        (0, vitest_1.expect)(context.outputPaths.featureFile).toBe("src/test/resources/features/round_trip_flight_search.feature");
    });
    (0, vitest_1.it)("builds a meaningful java step definition class name", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Write a new Cucumber scenario for round trip flight search", buildFramework(), [buildRepoFile("src/test/java/com/enuygun/stepdefinitions/FlightSearchSteps.java")]);
        (0, vitest_1.expect)(context.outputPaths.stepDefinition).toBe("src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java");
    });
    (0, vitest_1.it)("removes filler words from generated names", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Please create a new Cucumber scenario for the flight search test", buildFramework(), []);
        (0, vitest_1.expect)(context.outputPaths.featureFile).toBe("src/test/resources/features/flight_search.feature");
    });
    (0, vitest_1.it)("keeps naming deterministic", () => {
        const first = (0, testEngineerContext_js_1.buildTestEngineerContext)("Write a new Cucumber scenario for round trip flight search", buildFramework(), []);
        const second = (0, testEngineerContext_js_1.buildTestEngineerContext)("Write a new Cucumber scenario for round trip flight search", buildFramework(), []);
        (0, vitest_1.expect)(first.outputPaths).toEqual(second.outputPaths);
    });
    (0, vitest_1.it)("sanitizes unsafe characters while preserving core intent words", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Please generate: round-trip flight search!!! @#$%^&*()", buildFramework(), []);
        (0, vitest_1.expect)(context.outputPaths.featureFile).toBe("src/test/resources/features/round_trip_flight_search.feature");
        (0, vitest_1.expect)(context.outputPaths.stepDefinition).toBe("src/test/java/com/stepdefinitions/RoundTripFlightSearchSteps.java");
    });
    (0, vitest_1.it)("keeps existing framework-aware output directories intact", () => {
        const files = [
            buildRepoFile("src/test/resources/features/flight_search.feature"),
            buildRepoFile("src/test/java/com/enuygun/stepdefinitions/FlightSearchSteps.java"),
        ];
        const cucumberContext = (0, testEngineerContext_js_1.buildTestEngineerContext)("Write a new Cucumber scenario for round trip flight search", buildFramework(), files);
        const cypressContext = (0, testEngineerContext_js_1.buildTestEngineerContext)("Generate a login smoke test", buildFramework({
            framework: "cypress",
            language: "typescript",
            testFilePattern: "*.cy.ts",
            testDir: "cypress/e2e",
        }), files);
        (0, vitest_1.expect)(cucumberContext.outputPaths.featureFile).toBe("src/test/resources/features/round_trip_flight_search.feature");
        (0, vitest_1.expect)(cucumberContext.outputPaths.stepDefinition).toBe("src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java");
        (0, vitest_1.expect)(cypressContext.outputPaths.testFile).toBe("cypress/e2e/login.cy.ts");
    });
    (0, vitest_1.it)("reuses the closest matching existing Playwright spec instead of inventing a prompt-based filename", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("You are a code agent. Analyze repo and add a negative login test case.", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [
            buildRepoFile("tests/login.spec.ts"),
            buildRepoFile("tests/checkout.spec.ts"),
        ]);
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/login.spec.ts");
    });
    (0, vitest_1.it)("strongly prefers an existing auth-related Playwright spec for login tasks", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add coverage for invalid credentials on sign in", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [
            buildRepoFile("tests/account-settings.spec.ts"),
            buildRepoFile("tests/authentication.spec.ts"),
            buildRepoFile("tests/profile.spec.ts"),
        ]);
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/authentication.spec.ts");
        (0, vitest_1.expect)(context.debug.hasLoginIntent).toBe(true);
        (0, vitest_1.expect)(context.debug.loginSubIntent).toBe("invalid_credentials");
        (0, vitest_1.expect)(context.debug.chosenExistingTestFile).toBe("tests/authentication.spec.ts");
        (0, vitest_1.expect)(context.debug.finalOutputPathSource).toBe("existing_test_file");
        (0, vitest_1.expect)(context.debug.candidateTestFiles[0]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/authentication.spec.ts",
            suspiciousGenerated: false,
        }));
    });
    (0, vitest_1.it)("does not prefer a username-specific login spec over a better invalid-credentials candidate", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add a negative login test for invalid credentials", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [
            buildRepoFile("tests/playwright_saucedemo_login_username.spec.ts"),
            buildRepoFile("tests/login_invalid_credentials.spec.ts"),
        ]);
        (0, vitest_1.expect)(context.debug.loginSubIntent).toBe("invalid_credentials");
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/login_invalid_credentials.spec.ts");
        (0, vitest_1.expect)(context.debug.candidateTestFiles[0]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/login_invalid_credentials.spec.ts",
            subIntentScore: 20,
        }));
        (0, vitest_1.expect)(context.debug.candidateTestFiles[1]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/playwright_saucedemo_login_username.spec.ts",
            subIntentScore: -18,
        }));
    });
    (0, vitest_1.it)("still prefers a username-specific spec for username-validation tasks", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add login username validation coverage for empty username", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [
            buildRepoFile("tests/login.spec.ts"),
            buildRepoFile("tests/login_username.spec.ts"),
        ]);
        (0, vitest_1.expect)(context.debug.loginSubIntent).toBe("username_validation");
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/login_username.spec.ts");
        (0, vitest_1.expect)(context.debug.candidateTestFiles[0]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/login_username.spec.ts",
            subIntentScore: 18,
        }));
    });
    (0, vitest_1.it)("lets broad login tasks prefer a general login spec over narrower specialized files", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add general login coverage", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [
            buildRepoFile("tests/login.spec.ts"),
            buildRepoFile("tests/login_username.spec.ts"),
        ]);
        (0, vitest_1.expect)(context.debug.loginSubIntent).toBe("general_login");
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/login.spec.ts");
        (0, vitest_1.expect)(context.debug.candidateTestFiles[0]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/login.spec.ts",
            subIntentScore: 10,
        }));
    });
    (0, vitest_1.it)("falls back to a clean new login file when no semantically close existing login file exists", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add a negative login test for invalid credentials", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [buildRepoFile("tests/playwright_saucedemo_login_username.spec.ts")]);
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/login.spec.ts");
        (0, vitest_1.expect)(context.debug.finalOutputPathSource).toBe("generated_fallback");
        (0, vitest_1.expect)(context.debug.candidateTestFiles[0]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/playwright_saucedemo_login_username.spec.ts",
            subIntentScore: -18,
        }));
    });
    (0, vitest_1.it)("keeps sub-intent ranking deterministic across identical inputs", () => {
        const files = [
            buildRepoFile("tests/playwright_saucedemo_login_username.spec.ts"),
            buildRepoFile("tests/login_invalid_credentials.spec.ts"),
            buildRepoFile("tests/login.spec.ts"),
        ];
        const framework = buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        });
        const first = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add a negative login test for invalid credentials", framework, files);
        const second = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add a negative login test for invalid credentials", framework, files);
        (0, vitest_1.expect)(first.outputPaths).toEqual(second.outputPaths);
        (0, vitest_1.expect)(first.debug.candidateTestFiles).toEqual(second.debug.candidateTestFiles);
    });
    (0, vitest_1.it)("down-ranks a suspicious generated login task slug below a real auth spec", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add a negative login test for invalid credentials", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [
            buildRepoFile("tests/add_negative_login_invalid_requirements.spec.ts"),
            buildRepoFile("tests/login.spec.ts"),
        ]);
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/login.spec.ts");
        (0, vitest_1.expect)(context.debug.candidateTestFiles[0]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/login.spec.ts",
            suspiciousGenerated: false,
        }));
        (0, vitest_1.expect)(context.debug.candidateTestFiles[1]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/add_negative_login_invalid_requirements.spec.ts",
            suspiciousGenerated: true,
        }));
        (0, vitest_1.expect)(context.debug.candidateTestFiles[1].suspiciousGeneratedPenalty).toBe(-50);
    });
    (0, vitest_1.it)("penalizes suspicious generated task-slug files deterministically when no better auth file exists", () => {
        const first = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add a negative login test for invalid credentials", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [buildRepoFile("tests/task_generated_login_case.spec.ts")]);
        const second = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add a negative login test for invalid credentials", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [buildRepoFile("tests/task_generated_login_case.spec.ts")]);
        (0, vitest_1.expect)(first.outputPaths.testFile).toBe("tests/login.spec.ts");
        (0, vitest_1.expect)(first.debug.candidateTestFiles[0]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/task_generated_login_case.spec.ts",
            suspiciousGenerated: true,
            suspiciousGeneratedPenalty: -50,
        }));
        (0, vitest_1.expect)(first.outputPaths).toEqual(second.outputPaths);
        (0, vitest_1.expect)(first.debug.candidateTestFiles).toEqual(second.debug.candidateTestFiles);
    });
    (0, vitest_1.it)("keeps concise repository-native login specs preferred and unaffected", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add coverage for invalid credentials on login", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [
            buildRepoFile("tests/login.spec.ts"),
            buildRepoFile("tests/auth.spec.ts"),
        ]);
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/login.spec.ts");
        (0, vitest_1.expect)(context.debug.candidateTestFiles).toEqual([
            vitest_1.expect.objectContaining({
                path: "tests/login.spec.ts",
                suspiciousGenerated: false,
            }),
            vitest_1.expect.objectContaining({
                path: "tests/auth.spec.ts",
                suspiciousGenerated: false,
            }),
        ]);
    });
    (0, vitest_1.it)("does not penalize normal repository-native non-auth test files", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add checkout smoke coverage", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [
            buildRepoFile("tests/checkout.spec.ts"),
            buildRepoFile("tests/cart.spec.ts"),
        ]);
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/checkout.spec.ts");
        (0, vitest_1.expect)(context.debug.candidateTestFiles[0]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/checkout.spec.ts",
            suspiciousGenerated: false,
            suspiciousGeneratedPenalty: 0,
        }));
        (0, vitest_1.expect)(context.debug.candidateTestFiles[1]).toEqual(vitest_1.expect.objectContaining({
            path: "tests/cart.spec.ts",
            suspiciousGenerated: false,
            suspiciousGeneratedPenalty: 0,
        }));
    });
    (0, vitest_1.it)("falls back to a safe deterministic basename when prompt text is too generic", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("You are code agent analyze repository and implement the task", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), []);
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/app.spec.ts");
        (0, vitest_1.expect)(context.outputPaths.testFile).not.toContain("you_are_code_agent_analyze");
        (0, vitest_1.expect)(context.outputPaths.testFile).not.toContain("analyze_repo");
        (0, vitest_1.expect)(context.debug.suspiciousFilenameRejected).toBe(true);
        (0, vitest_1.expect)(context.debug.generatedSlug).toBe("you_are_code_agent_analyze");
        (0, vitest_1.expect)(context.debug.safeSlug).toBe("app");
    });
    (0, vitest_1.it)("uses a short repository-native login basename when no auth spec exists yet", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Add negative login invalid requirements for auth request prompt", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), [buildRepoFile("tests/checkout.spec.ts")]);
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/login.spec.ts");
        (0, vitest_1.expect)(context.outputPaths.testFile).not.toContain("add_negative_login_invalid_requirements");
    });
    (0, vitest_1.it)("blocks suspicious task-derived Playwright filenames from becoming output paths", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Create task prompt for code agent to analyze repo and write login test requirements", buildFramework({
            framework: "playwright_ts",
            language: "typescript",
            testFilePattern: "*.spec.ts",
            testDir: "tests",
        }), []);
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("tests/login.spec.ts");
        (0, vitest_1.expect)(context.outputPaths.testFile).not.toContain("task");
        (0, vitest_1.expect)(context.outputPaths.testFile).not.toContain("agent");
        (0, vitest_1.expect)(context.outputPaths.testFile).not.toContain("requirements");
        (0, vitest_1.expect)(context.debug.generatedSlug).toBe("login");
        (0, vitest_1.expect)(context.debug.suspiciousFilenameRejected).toBe(false);
        (0, vitest_1.expect)(context.debug.finalOutputPathSource).toBe("generated_fallback");
    });
    (0, vitest_1.it)("prefers src/test/resources/features when both feature roots exist", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Write a new Cucumber scenario for round trip flight search", buildFramework({
            testDir: "features",
        }), [
            buildRepoFile("features/flight_search.feature"),
            buildRepoFile("src/test/resources/features/flight_search.feature"),
        ]);
        (0, vitest_1.expect)(context.outputPaths.featureFile).toBe("src/test/resources/features/round_trip_flight_search.feature");
        (0, vitest_1.expect)(context.outputPaths.testFile).toBe("src/test/resources/features/round_trip_flight_search.feature");
    });
    (0, vitest_1.it)("falls back to generic features root when that is the only feature root", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Write a new Cucumber scenario for round trip flight search", buildFramework({
            testDir: "features",
        }), [buildRepoFile("features/flight_search.feature")]);
        (0, vitest_1.expect)(context.outputPaths.featureFile).toBe("features/round_trip_flight_search.feature");
    });
    (0, vitest_1.it)("prioritizes src/test/resources/features examples before generic features examples", () => {
        const context = (0, testEngineerContext_js_1.buildTestEngineerContext)("Write a new Cucumber scenario for round trip flight search", buildFramework({
            testDir: "features",
        }), [
            buildRepoFile("features/flight_search.feature"),
            buildRepoFile("src/test/resources/features/flight_search.feature"),
            buildRepoFile("src/test/resources/features/booking.feature"),
        ]);
        (0, vitest_1.expect)(context.featureFiles.map((file) => file.path)).toEqual([
            "src/test/resources/features/booking.feature",
            "src/test/resources/features/flight_search.feature",
            "features/flight_search.feature",
        ]);
    });
});
//# sourceMappingURL=testEngineerContext.test.js.map