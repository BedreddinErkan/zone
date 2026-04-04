import { describe, expect, it } from "vitest";
import { buildTestEngineerPrompt } from "./testEngineerPrompt.js";
import type { TestEngineerContext } from "../roles/testEngineerContext.js";
import type { DetectedTestFramework } from "../roles/detectTestFramework.js";

function buildFramework(
  overrides: Partial<DetectedTestFramework> = {}
): DetectedTestFramework {
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

function buildContext(
  overrides: Partial<TestEngineerContext> = {}
): TestEngineerContext {
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
      stepDefinition:
        "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java",
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
      fallbackTestFilePath:
        "src/test/resources/features/round_trip_flight_search.feature",
      finalOutputPath: "src/test/resources/features/round_trip_flight_search.feature",
      finalOutputPathSource: "generated_fallback",
    },
    ...overrides,
  };
}

describe("buildTestEngineerPrompt", () => {
  it("includes step-definition examples when available", () => {
    const prompt = buildTestEngineerPrompt({
      task: "Write a new Cucumber scenario for round trip flight search",
      context: buildContext(),
      pageObjectContents: [],
      stepDefinitionContents: [
        {
          path: "src/test/java/com/enuygun/stepdefinitions/FlightSearchSteps.java",
          content:
            "package com.enuygun.stepdefinitions;\n\npublic class FlightSearchSteps {}",
        },
      ],
      featureContents: [],
      existingTestContents: [],
    });

    expect(prompt).toContain("=== EXISTING STEP DEFINITION EXAMPLES ===");
    expect(prompt).toContain(
      "src/test/java/com/enuygun/stepdefinitions/FlightSearchSteps.java"
    );
    expect(prompt).toContain("package com.enuygun.stepdefinitions;");
  });

  it("includes feature-file examples when available", () => {
    const prompt = buildTestEngineerPrompt({
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

    expect(prompt).toContain("=== EXISTING FEATURE FILE EXAMPLES ===");
    expect(prompt).toContain("src/test/resources/features/flight_search.feature");
    expect(prompt).toContain("Feature: Flight search");
  });

  it("includes page object usage hints when available", () => {
    const prompt = buildTestEngineerPrompt({
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

    expect(prompt).toContain("=== PAGE OBJECT USAGE HINTS ===");
    expect(prompt).toContain("- src/main/java/com/enuygun/pages/HomePage.java");
    expect(prompt).toContain("searchFlights");
  });

  it("remains stable when no examples exist", () => {
    const prompt = buildTestEngineerPrompt({
      task: "Write a new Cucumber scenario for round trip flight search",
      context: buildContext(),
      pageObjectContents: [],
      stepDefinitionContents: [],
      featureContents: [],
      existingTestContents: [],
    });

    expect(prompt).toContain("(no page objects found)");
    expect(prompt).toContain("(no page object usage hints found)");
    expect(prompt).toContain("(no existing step definition examples found)");
    expect(prompt).toContain("(no existing feature file examples found)");
    expect(prompt).toContain("(no existing tests found)");
  });

  it("keeps cucumber java output requirements framework-aware", () => {
    const prompt = buildTestEngineerPrompt({
      task: "Write a new Cucumber scenario for round trip flight search",
      context: buildContext(),
      pageObjectContents: [],
      stepDefinitionContents: [],
      featureContents: [],
      existingTestContents: [],
    });

    expect(prompt).toContain(
      "Feature file: src/test/resources/features/round_trip_flight_search.feature"
    );
    expect(prompt).toContain(
      "Step definitions: src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java"
    );
    expect(prompt).toContain("For Cucumber Java: write both feature file AND step definitions.");
    expect(prompt).toContain(
      "Reuse existing feature phrasing, step annotations, package names, imports, and page object usage patterns when examples are provided."
    );
  });

  it("explicitly forbids generic urls and placeholder data", () => {
    const prompt = buildTestEngineerPrompt({
      task: "Write a new Cucumber scenario for round trip flight search",
      context: buildContext(),
      pageObjectContents: [],
      stepDefinitionContents: [],
      featureContents: [],
      existingTestContents: [],
    });

    expect(prompt).toContain(
      'NEVER use placeholder URLs or placeholder data such as "http://example.com", "https://example.com", or fake cities/dates when repository-style phrasing examples exist.'
    );
  });

  it("explicitly forbids invented convenience methods unless they already exist", () => {
    const prompt = buildTestEngineerPrompt({
      task: "Write a new Cucumber scenario for round trip flight search",
      context: buildContext(),
      pageObjectContents: [],
      stepDefinitionContents: [],
      featureContents: [],
      existingTestContents: [],
    });

    expect(prompt).toContain(
      'Compose step definitions from existing page object methods instead of inventing new convenience methods.'
    );
    expect(prompt).toContain(
      'NEVER call a convenience method such as "searchRoundTripFlight(...)" unless that exact method exists in the provided page objects.'
    );
  });

  it("requires scenario outline with examples when repo examples use that style", () => {
    const prompt = buildTestEngineerPrompt({
      task: "Write a new Cucumber scenario for round trip flight search",
      context: buildContext(),
      pageObjectContents: [],
      stepDefinitionContents: [],
      featureContents: [
        {
          path: "src/test/resources/features/flight_search.feature",
          content:
            "Feature: Enuygun flight search functionality\n@ui\nScenario Outline: Verify round-trip flight search\nExamples:\n| departureCity | arrivalCity |",
        },
      ],
      existingTestContents: [],
    });

    expect(prompt).toContain(
      'When repository examples use "Scenario Outline" with an "Examples:" table, you MUST use the same pattern for parameterized search tasks unless a concrete repository-specific reason prevents it.'
    );
  });

  it("clearly requires existing page object methods and warning on missing ones", () => {
    const prompt = buildTestEngineerPrompt({
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

    expect(prompt).toContain(
      "Use ONLY the exact method names found in the page objects above."
    );
    expect(prompt).toContain(
      "If a required method does not exist in the page objects, add it to warnings with the missing method names clearly listed."
    );
  });

  it("forbids collapsing multiple actions into invented abstractions", () => {
    const prompt = buildTestEngineerPrompt({
      task: "Write a new Cucumber scenario for round trip flight search",
      context: buildContext(),
      pageObjectContents: [],
      stepDefinitionContents: [],
      featureContents: [],
      existingTestContents: [],
    });

    expect(prompt).toContain(
      "Do NOT collapse multiple UI actions into a single invented abstraction, helper, or convenience step."
    );
  });

  it("requires close mapping from step definitions to real page object calls", () => {
    const prompt = buildTestEngineerPrompt({
      task: "Write a new Cucumber scenario for round trip flight search",
      context: buildContext(),
      pageObjectContents: [
        {
          path: "src/main/java/com/enuygun/pages/HomePage.java",
          content:
            "public class HomePage { void selectRoundTrip() {} void enterDepartureCity(String city) {} }",
        },
      ],
      stepDefinitionContents: [],
      featureContents: [],
      existingTestContents: [],
    });

    expect(prompt).toContain(
      "Each generated step definition method body must map closely to one or a small number of real page object method calls."
    );
  });

  it("requires repository-specific phrasing instead of generic fallback when examples exist", () => {
    const prompt = buildTestEngineerPrompt({
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

    expect(prompt).toContain(
      "If repository-specific phrasing exists in the provided examples, do NOT fall back to generic phrasing."
    );
  });

  it("forbids unsupported Playwright URL assertions without route evidence", () => {
    const prompt = buildTestEngineerPrompt({
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

    expect(prompt).toContain(
      "For Playwright: only use expect(page).toHaveURL(...) when repository examples or context show real route evidence. Do NOT invent wildcard, hash-only, or placeholder URL assertions."
    );
    expect(prompt).toContain(
      "If repository evidence does not establish a success route, prefer visible error-state assertions over redirect assertions."
    );
  });
});
