import { describe, expect, it } from "vitest";
import { buildTestEngineerContext } from "./testEngineerContext.js";
import type { DetectedTestFramework } from "./detectTestFramework.js";
import type { RepoFile } from "../types/project.js";

function buildFramework(
  overrides: Partial<DetectedTestFramework> = {}
): DetectedTestFramework {
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

function buildRepoFile(path: string): RepoFile {
  return {
    path,
    absolutePath: `C:/repo/${path}`,
    extension: path.split(".").pop() ?? "",
    category: "unknown",
  };
}

describe("buildTestEngineerContext output naming", () => {
  it("produces a concise cucumber feature slug from task intent", () => {
    const context = buildTestEngineerContext(
      "Write a new Cucumber scenario for round trip flight search",
      buildFramework(),
      []
    );

    expect(context.outputPaths.featureFile).toBe(
      "src/test/resources/features/round_trip_flight_search.feature"
    );
  });

  it("builds a meaningful java step definition class name", () => {
    const context = buildTestEngineerContext(
      "Write a new Cucumber scenario for round trip flight search",
      buildFramework(),
      [buildRepoFile("src/test/java/com/enuygun/stepdefinitions/FlightSearchSteps.java")]
    );

    expect(context.outputPaths.stepDefinition).toBe(
      "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java"
    );
  });

  it("removes filler words from generated names", () => {
    const context = buildTestEngineerContext(
      "Please create a new Cucumber scenario for the flight search test",
      buildFramework(),
      []
    );

    expect(context.outputPaths.featureFile).toBe(
      "src/test/resources/features/flight_search.feature"
    );
  });

  it("keeps naming deterministic", () => {
    const first = buildTestEngineerContext(
      "Write a new Cucumber scenario for round trip flight search",
      buildFramework(),
      []
    );
    const second = buildTestEngineerContext(
      "Write a new Cucumber scenario for round trip flight search",
      buildFramework(),
      []
    );

    expect(first.outputPaths).toEqual(second.outputPaths);
  });

  it("sanitizes unsafe characters while preserving core intent words", () => {
    const context = buildTestEngineerContext(
      "Please generate: round-trip flight search!!! @#$%^&*()",
      buildFramework(),
      []
    );

    expect(context.outputPaths.featureFile).toBe(
      "src/test/resources/features/round_trip_flight_search.feature"
    );
    expect(context.outputPaths.stepDefinition).toBe(
      "src/test/java/com/stepdefinitions/RoundTripFlightSearchSteps.java"
    );
  });

  it("keeps existing framework-aware output directories intact", () => {
    const files: RepoFile[] = [
      buildRepoFile("src/test/resources/features/flight_search.feature"),
      buildRepoFile("src/test/java/com/enuygun/stepdefinitions/FlightSearchSteps.java"),
    ];

    const cucumberContext = buildTestEngineerContext(
      "Write a new Cucumber scenario for round trip flight search",
      buildFramework(),
      files
    );
    const cypressContext = buildTestEngineerContext(
      "Generate a login smoke test",
      buildFramework({
        framework: "cypress",
        language: "typescript",
        testFilePattern: "*.cy.ts",
        testDir: "cypress/e2e",
      }),
      files
    );

    expect(cucumberContext.outputPaths.featureFile).toBe(
      "src/test/resources/features/round_trip_flight_search.feature"
    );
    expect(cucumberContext.outputPaths.stepDefinition).toBe(
      "src/test/java/com/enuygun/stepdefinitions/RoundTripFlightSearchSteps.java"
    );
    expect(cypressContext.outputPaths.testFile).toBe(
      "cypress/e2e/login_smoke.cy.ts"
    );
  });

  it("prefers src/test/resources/features when both feature roots exist", () => {
    const context = buildTestEngineerContext(
      "Write a new Cucumber scenario for round trip flight search",
      buildFramework({
        testDir: "features",
      }),
      [
        buildRepoFile("features/flight_search.feature"),
        buildRepoFile("src/test/resources/features/flight_search.feature"),
      ]
    );

    expect(context.outputPaths.featureFile).toBe(
      "src/test/resources/features/round_trip_flight_search.feature"
    );
    expect(context.outputPaths.testFile).toBe(
      "src/test/resources/features/round_trip_flight_search.feature"
    );
  });

  it("falls back to generic features root when that is the only feature root", () => {
    const context = buildTestEngineerContext(
      "Write a new Cucumber scenario for round trip flight search",
      buildFramework({
        testDir: "features",
      }),
      [buildRepoFile("features/flight_search.feature")]
    );

    expect(context.outputPaths.featureFile).toBe(
      "features/round_trip_flight_search.feature"
    );
  });

  it("prioritizes src/test/resources/features examples before generic features examples", () => {
    const context = buildTestEngineerContext(
      "Write a new Cucumber scenario for round trip flight search",
      buildFramework({
        testDir: "features",
      }),
      [
        buildRepoFile("features/flight_search.feature"),
        buildRepoFile("src/test/resources/features/flight_search.feature"),
        buildRepoFile("src/test/resources/features/booking.feature"),
      ]
    );

    expect(context.featureFiles.map((file) => file.path)).toEqual([
      "src/test/resources/features/booking.feature",
      "src/test/resources/features/flight_search.feature",
      "features/flight_search.feature",
    ]);
  });
});
