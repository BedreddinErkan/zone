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
    expect(cypressContext.outputPaths.testFile).toBe("cypress/e2e/login.cy.ts");
  });

  it("reuses the closest matching existing Playwright spec instead of inventing a prompt-based filename", () => {
    const context = buildTestEngineerContext(
      "You are a code agent. Analyze repo and add a negative login test case.",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      [
        buildRepoFile("tests/login.spec.ts"),
        buildRepoFile("tests/checkout.spec.ts"),
      ]
    );

    expect(context.outputPaths.testFile).toBe("tests/login.spec.ts");
  });

  it("strongly prefers an existing auth-related Playwright spec for login tasks", () => {
    const context = buildTestEngineerContext(
      "Add coverage for invalid credentials on sign in",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      [
        buildRepoFile("tests/account-settings.spec.ts"),
        buildRepoFile("tests/authentication.spec.ts"),
        buildRepoFile("tests/profile.spec.ts"),
      ]
    );

    expect(context.outputPaths.testFile).toBe("tests/authentication.spec.ts");
    expect(context.debug.hasLoginIntent).toBe(true);
    expect(context.debug.chosenExistingTestFile).toBe("tests/authentication.spec.ts");
    expect(context.debug.finalOutputPathSource).toBe("existing_test_file");
    expect(context.debug.candidateTestFiles[0]).toEqual(
      expect.objectContaining({
        path: "tests/authentication.spec.ts",
        suspiciousGenerated: false,
      })
    );
  });

  it("down-ranks a suspicious generated login task slug below a real auth spec", () => {
    const context = buildTestEngineerContext(
      "Add a negative login test for invalid credentials",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      [
        buildRepoFile("tests/add_negative_login_invalid_requirements.spec.ts"),
        buildRepoFile("tests/login.spec.ts"),
      ]
    );

    expect(context.outputPaths.testFile).toBe("tests/login.spec.ts");
    expect(context.debug.candidateTestFiles[0]).toEqual(
      expect.objectContaining({
        path: "tests/login.spec.ts",
        suspiciousGenerated: false,
      })
    );
    expect(context.debug.candidateTestFiles[1]).toEqual(
      expect.objectContaining({
        path: "tests/add_negative_login_invalid_requirements.spec.ts",
        suspiciousGenerated: true,
      })
    );
    expect(context.debug.candidateTestFiles[1].suspiciousGeneratedPenalty).toBe(-50);
  });

  it("penalizes suspicious generated task-slug files deterministically when no better auth file exists", () => {
    const first = buildTestEngineerContext(
      "Add a negative login test for invalid credentials",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      [buildRepoFile("tests/task_generated_login_case.spec.ts")]
    );
    const second = buildTestEngineerContext(
      "Add a negative login test for invalid credentials",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      [buildRepoFile("tests/task_generated_login_case.spec.ts")]
    );

    expect(first.outputPaths.testFile).toBe("tests/login.spec.ts");
    expect(first.debug.candidateTestFiles[0]).toEqual(
      expect.objectContaining({
        path: "tests/task_generated_login_case.spec.ts",
        suspiciousGenerated: true,
        suspiciousGeneratedPenalty: -50,
      })
    );
    expect(first.outputPaths).toEqual(second.outputPaths);
    expect(first.debug.candidateTestFiles).toEqual(second.debug.candidateTestFiles);
  });

  it("keeps concise repository-native login specs preferred and unaffected", () => {
    const context = buildTestEngineerContext(
      "Add coverage for invalid credentials on login",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      [
        buildRepoFile("tests/login.spec.ts"),
        buildRepoFile("tests/auth.spec.ts"),
      ]
    );

    expect(context.outputPaths.testFile).toBe("tests/login.spec.ts");
    expect(context.debug.candidateTestFiles).toEqual([
      expect.objectContaining({
        path: "tests/login.spec.ts",
        suspiciousGenerated: false,
      }),
      expect.objectContaining({
        path: "tests/auth.spec.ts",
        suspiciousGenerated: false,
      }),
    ]);
  });

  it("does not penalize normal repository-native non-auth test files", () => {
    const context = buildTestEngineerContext(
      "Add checkout smoke coverage",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      [
        buildRepoFile("tests/checkout.spec.ts"),
        buildRepoFile("tests/cart.spec.ts"),
      ]
    );

    expect(context.outputPaths.testFile).toBe("tests/checkout.spec.ts");
    expect(context.debug.candidateTestFiles[0]).toEqual(
      expect.objectContaining({
        path: "tests/checkout.spec.ts",
        suspiciousGenerated: false,
        suspiciousGeneratedPenalty: 0,
      })
    );
    expect(context.debug.candidateTestFiles[1]).toEqual(
      expect.objectContaining({
        path: "tests/cart.spec.ts",
        suspiciousGenerated: false,
        suspiciousGeneratedPenalty: 0,
      })
    );
  });

  it("falls back to a safe deterministic basename when prompt text is too generic", () => {
    const context = buildTestEngineerContext(
      "You are code agent analyze repository and implement the task",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      []
    );

    expect(context.outputPaths.testFile).toBe("tests/app.spec.ts");
    expect(context.outputPaths.testFile).not.toContain("you_are_code_agent_analyze");
    expect(context.outputPaths.testFile).not.toContain("analyze_repo");
    expect(context.debug.suspiciousFilenameRejected).toBe(true);
    expect(context.debug.generatedSlug).toBe("you_are_code_agent_analyze");
    expect(context.debug.safeSlug).toBe("app");
  });

  it("uses a short repository-native login basename when no auth spec exists yet", () => {
    const context = buildTestEngineerContext(
      "Add negative login invalid requirements for auth request prompt",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      [buildRepoFile("tests/checkout.spec.ts")]
    );

    expect(context.outputPaths.testFile).toBe("tests/login.spec.ts");
    expect(context.outputPaths.testFile).not.toContain("add_negative_login_invalid_requirements");
  });

  it("blocks suspicious task-derived Playwright filenames from becoming output paths", () => {
    const context = buildTestEngineerContext(
      "Create task prompt for code agent to analyze repo and write login test requirements",
      buildFramework({
        framework: "playwright_ts",
        language: "typescript",
        testFilePattern: "*.spec.ts",
        testDir: "tests",
      }),
      []
    );

    expect(context.outputPaths.testFile).toBe("tests/login.spec.ts");
    expect(context.outputPaths.testFile).not.toContain("task");
    expect(context.outputPaths.testFile).not.toContain("agent");
    expect(context.outputPaths.testFile).not.toContain("requirements");
    expect(context.debug.generatedSlug).toBe("login");
    expect(context.debug.suspiciousFilenameRejected).toBe(false);
    expect(context.debug.finalOutputPathSource).toBe("generated_fallback");
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
