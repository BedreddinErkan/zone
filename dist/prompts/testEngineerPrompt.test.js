"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const testEngineerPrompt_js_1 = require("./testEngineerPrompt.js");
function buildFramework(overrides = {}) {
    return {
        framework: "cucumber_java",
        confidence: "high",
        language: "java",
        evidence: ["pom.xml", ".feature", ".java"],
        testFilePattern: "*.feature",
        testDir: "src/test/resources/features",
        ...overrides,
    };
}
function buildContext(overrides = {}) {
    const framework = overrides.framework ?? buildFramework();
    return {
        framework,
        existingTestFiles: [],
        pageObjectFiles: [],
        stepDefinitionFiles: [],
        featureFiles: [],
        configFiles: [],
        frameworkSummary: "Test framework: cucumber_java",
        promptRole: "You are a senior test automation engineer specializing in Cucumber BDD with Java.",
        outputRules: ["Use Given/When/Then"],
        fileLocationRules: ["Feature files: src/test/resources/features/"],
        outputPaths: {
            testFile: "src/test/resources/features/round_trip_flight_search.feature",
            featureFile: "src/test/resources/features/round_trip_flight_search.feature",
            stepDefinition: "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
        },
        debug: {
            selectedRole: "test_engineer",
            normalizedTask: "write a new cucumber scenario for round trip flight search",
            intentTokens: ["round", "trip", "flight", "search"],
            hasLoginIntent: false,
            preferredBasenameToken: null,
            candidateTestFiles: [],
            chosenExistingTestFile: null,
            generatedSlug: "round_trip_flight_search",
            safeSlug: "round_trip_flight_search",
            suspiciousFilenameRejected: false,
            fallbackTestFilePath: "src/test/resources/features/round_trip_flight_search.feature",
            finalOutputPath: "src/test/resources/features/round_trip_flight_search.feature",
            finalOutputPathSource: "generated_fallback",
        },
        ...overrides,
    };
}
(0, vitest_1.describe)("buildTestEngineerPrompt", () => {
    (0, vitest_1.it)("includes step-definition examples when available", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [],
            stepDefinitionContents: [
                {
                    path: "src/test/java/com/enuygun/stepdefinitions/FlightSearchSteps.java",
                    content: "package com.enuygun.stepdefinitions;\n\npublic class FlightSearchSteps {}",
                },
            ],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("=== EXISTING STEP DEFINITION EXAMPLES ===");
        (0, vitest_1.expect)(prompt).toContain("src/test/java/com/enuygun/stepdefinitions/FlightSearchSteps.java");
        (0, vitest_1.expect)(prompt).toContain("package com.enuygun.stepdefinitions;");
    });
    (0, vitest_1.it)("includes feature-file examples when available", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [],
            stepDefinitionContents: [],
            featureContents: [
                {
                    path: "src/test/resources/features/flight_search.feature",
                    content: "Feature: Flight search\n  Scenario: Search one way flights",
                },
            ],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("=== EXISTING FEATURE FILE EXAMPLES ===");
        (0, vitest_1.expect)(prompt).toContain("src/test/resources/features/flight_search.feature");
        (0, vitest_1.expect)(prompt).toContain("Feature: Flight search");
    });
    (0, vitest_1.it)("includes page object usage hints when available", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [
                {
                    path: "src/main/java/com/enuygun/pages/HomePage.java",
                    content: "public class HomePage { void searchFlights() {} }",
                },
            ],
            stepDefinitionContents: [],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("=== PAGE OBJECT USAGE HINTS ===");
        (0, vitest_1.expect)(prompt).toContain("- src/main/java/com/enuygun/pages/HomePage.java");
        (0, vitest_1.expect)(prompt).toContain("searchFlights");
    });
    (0, vitest_1.it)("remains stable when no examples exist", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [],
            stepDefinitionContents: [],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("(no page objects found)");
        (0, vitest_1.expect)(prompt).toContain("(no page object usage hints found)");
        (0, vitest_1.expect)(prompt).toContain("(no existing step definition examples found)");
        (0, vitest_1.expect)(prompt).toContain("(no existing feature file examples found)");
        (0, vitest_1.expect)(prompt).toContain("(no existing tests found)");
    });
    (0, vitest_1.it)("keeps cucumber java output requirements framework-aware", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [],
            stepDefinitionContents: [],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("Feature file: src/test/resources/features/round_trip_flight_search.feature");
        (0, vitest_1.expect)(prompt).toContain("Step definitions: src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java");
        (0, vitest_1.expect)(prompt).toContain("For Cucumber Java: write both feature file AND step definitions.");
        (0, vitest_1.expect)(prompt).toContain("Reuse existing feature phrasing, step annotations, package names, imports, and page object usage patterns when examples are provided.");
    });
    (0, vitest_1.it)("explicitly forbids generic urls and placeholder data", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [],
            stepDefinitionContents: [],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain('NEVER use placeholder URLs or placeholder data such as "http://example.com", "https://example.com", or fake cities/dates when repository-style phrasing examples exist.');
    });
    (0, vitest_1.it)("explicitly forbids invented convenience methods unless they already exist", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [],
            stepDefinitionContents: [],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain('Compose step definitions from existing page object methods instead of inventing new convenience methods.');
        (0, vitest_1.expect)(prompt).toContain('NEVER call a convenience method such as "searchRoundTripFlight(...)" unless that exact method exists in the provided page objects.');
    });
    (0, vitest_1.it)("requires scenario outline with examples when repo examples use that style", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [],
            stepDefinitionContents: [],
            featureContents: [
                {
                    path: "src/test/resources/features/flight_search.feature",
                    content: "Feature: Enuygun flight search functionality\n@ui\nScenario Outline: Verify round-trip flight search\nExamples:\n| departureCity | arrivalCity |",
                },
            ],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain('When repository examples use "Scenario Outline" with an "Examples:" table, you MUST use the same pattern for parameterized search tasks unless a concrete repository-specific reason prevents it.');
    });
    (0, vitest_1.it)("clearly requires existing page object methods and warning on missing ones", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [
                {
                    path: "src/main/java/com/enuygun/pages/HomePage.java",
                    content: "public class HomePage { void enterDepartureCity(String city) {} }",
                },
            ],
            stepDefinitionContents: [],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("Use ONLY the exact method names found in the page objects above.");
        (0, vitest_1.expect)(prompt).toContain("If a required method does not exist in the page objects, add it to warnings with the missing method names clearly listed.");
    });
    (0, vitest_1.it)("forbids collapsing multiple actions into invented abstractions", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [],
            stepDefinitionContents: [],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("Do NOT collapse multiple UI actions into a single invented abstraction, helper, or convenience step.");
    });
    (0, vitest_1.it)("requires close mapping from step definitions to real page object calls", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [
                {
                    path: "src/main/java/com/enuygun/pages/HomePage.java",
                    content: "public class HomePage { void selectRoundTrip() {} void enterDepartureCity(String city) {} }",
                },
            ],
            stepDefinitionContents: [],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("Each generated step definition method body must map closely to one or a small number of real page object method calls.");
    });
    (0, vitest_1.it)("requires repository-specific phrasing instead of generic fallback when examples exist", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Write a new Cucumber scenario for round trip flight search",
            context: buildContext(),
            pageObjectContents: [],
            stepDefinitionContents: [],
            featureContents: [
                {
                    path: "src/test/resources/features/flight_search.feature",
                    content: "Feature: Enuygun flight search functionality",
                },
            ],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("If repository-specific phrasing exists in the provided examples, do NOT fall back to generic phrasing.");
    });
    (0, vitest_1.it)("forbids unsupported Playwright URL assertions without route evidence", () => {
        const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
            task: "Add a negative login test",
            context: buildContext({
                framework: buildFramework({
                    framework: "playwright_ts",
                    language: "typescript",
                    testFilePattern: "*.spec.ts",
                    testDir: "tests",
                }),
                frameworkSummary: "Test framework: playwright_ts",
                outputPaths: {
                    testFile: "tests/login.spec.ts",
                },
            }),
            pageObjectContents: [],
            stepDefinitionContents: [],
            featureContents: [],
            existingTestContents: [],
        });
        (0, vitest_1.expect)(prompt).toContain("For Playwright: only use expect(page).toHaveURL(...) when repository examples or context show real route evidence. Do NOT invent wildcard, hash-only, or placeholder URL assertions.");
        (0, vitest_1.expect)(prompt).toContain("If repository evidence does not establish a success route, prefer visible error-state assertions over redirect assertions.");
    });
});
//# sourceMappingURL=testEngineerPrompt.test.js.map