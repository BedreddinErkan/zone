import type { RepoFile } from "../types/project.js";

export type TestFramework =
  | "playwright_ts"
  | "playwright_js"
  | "selenium_java"
  | "selenium_python"
  | "cypress"
  | "pytest"
  | "junit"
  | "testng"
  | "cucumber_java"
  | "unknown";

export interface DetectedTestFramework {
  framework: TestFramework;
  confidence: "high" | "medium" | "low";
  language: "typescript" | "javascript" | "java" | "python" | "unknown";
  evidence: string[];
  testFilePattern: string;
  testDir: string | null;
}

function hasFile(files: RepoFile[], pattern: string): boolean {
  return files.some((f) => f.path.includes(pattern));
}

function hasExtension(files: RepoFile[], ext: string): boolean {
  return files.some((f) => f.path.endsWith(ext));
}

function hasJavaBuildFile(files: RepoFile[]): boolean {
  return (
    hasFile(files, "pom.xml") ||
    hasFile(files, "build.gradle") ||
    hasFile(files, "build.gradle.kts")
  );
}

function findTestDir(files: RepoFile[], patterns: string[]): string | null {
  for (const pattern of patterns) {
    const found = files.find((f) => f.path.includes(pattern));
    if (found) {
      const parts = found.path.split("/");
      const idx = parts.findIndex((p) => p === pattern.replace("/", ""));
      if (idx !== -1) return parts.slice(0, idx + 1).join("/");
    }
  }
  return null;
}

export function detectTestFramework(files: RepoFile[]): DetectedTestFramework {

 if (!Array.isArray(files)) {
    return {
      framework: "unknown",
      confidence: "low",
      language: "unknown",
      evidence: ["Invalid input: files is not an array"],
      testFilePattern: "*",
      testDir: null,
    };}
  const evidence: string[] = [];


  // Playwright TS
  if (hasFile(files, "playwright.config.ts")) {
    evidence.push("playwright.config.ts found");
    const hasSpecTs = files.some(
      (f) => f.path.endsWith(".spec.ts") || f.path.endsWith(".test.ts")
    );
    if (hasSpecTs) evidence.push(".spec.ts test files found");
    return {
      framework: "playwright_ts",
      confidence: "high",
      language: "typescript",
      evidence,
      testFilePattern: "*.spec.ts",
      testDir: findTestDir(files, ["tests", "e2e", "test"]),
    };
  }

  // Playwright JS
  if (hasFile(files, "playwright.config.js")) {
    evidence.push("playwright.config.js found");
    return {
      framework: "playwright_js",
      confidence: "high",
      language: "javascript",
      evidence,
      testFilePattern: "*.spec.js",
      testDir: findTestDir(files, ["tests", "e2e", "test"]),
    };
  }

  // Cypress
  if (
    hasFile(files, "cypress.config.ts") ||
    hasFile(files, "cypress.config.js") ||
    hasFile(files, "cypress/")
  ) {
    evidence.push("cypress.config found");
    return {
      framework: "cypress",
      confidence: "high",
      language: hasFile(files, "cypress.config.ts") ? "typescript" : "javascript",
      evidence,
      testFilePattern: "*.cy.ts",
      testDir: findTestDir(files, ["cypress/e2e", "cypress/integration"]),
    };
  }

  // Cucumber Java
  if (
    hasJavaBuildFile(files) &&
    hasFile(files, ".feature") &&
    hasExtension(files, ".java")
  ) {
    if (hasFile(files, "pom.xml")) evidence.push("pom.xml found");
    else if (hasFile(files, "build.gradle.kts")) evidence.push("build.gradle.kts found");
    else evidence.push("build.gradle found");
    evidence.push(".feature files found");
    evidence.push(".java files found");
    const hasSelenium = files.some(
      (f) =>
        f.path.includes("BasePage") ||
        f.path.includes("WebDriver") ||
        f.path.includes("selenium")
    );
    if (hasSelenium) evidence.push("Selenium page objects detected");
    return {
      framework: "cucumber_java",
      confidence: "high",
      language: "java",
      evidence,
      testFilePattern: "*.feature",
      testDir: findTestDir(files, [
        "src/test/resources/features",
        "features",
      ]),
    };
  }

  // Selenium Java (without Cucumber)
  if (hasJavaBuildFile(files) && hasExtension(files, ".java")) {
    if (hasFile(files, "pom.xml")) evidence.push("pom.xml found");
    else if (hasFile(files, "build.gradle.kts")) evidence.push("build.gradle.kts found");
    else evidence.push("build.gradle found");
    evidence.push(".java files found");
    const hasTestNG = hasFile(files, "testng.xml");
    if (hasTestNG) {
      evidence.push("testng.xml found");
      return {
        framework: "testng",
        confidence: "high",
        language: "java",
        evidence,
        testFilePattern: "*Test.java",
        testDir: findTestDir(files, ["src/test/java"]),
      };
    }
    return {
      framework: "selenium_java",
      confidence: "medium",
      language: "java",
      evidence,
      testFilePattern: "*Test.java",
      testDir: findTestDir(files, ["src/test/java"]),
    };
  }

  // Pytest
  if (
    hasFile(files, "pytest.ini") ||
    hasFile(files, "conftest.py") ||
    hasFile(files, "pyproject.toml")
  ) {
    evidence.push("pytest config found");
    const hasCypress = hasFile(files, "cypress");
    if (!hasCypress) {
      return {
        framework: "pytest",
        confidence: "high",
        language: "python",
        evidence,
        testFilePattern: "test_*.py",
        testDir: findTestDir(files, ["tests", "test"]),
      };
    }
  }

  // Selenium Python
  if (hasExtension(files, ".py")) {
    const hasSelenium = files.some(
      (f) => f.path.includes("selenium") || f.path.includes("webdriver")
    );
    if (hasSelenium) {
      evidence.push("Python + Selenium detected");
      return {
        framework: "selenium_python",
        confidence: "medium",
        language: "python",
        evidence,
        testFilePattern: "test_*.py",
        testDir: findTestDir(files, ["tests", "test"]),
      };
    }
  }

  // Unknown
  return {
    framework: "unknown",
    confidence: "low",
    language: "unknown",
    evidence: ["No recognizable test framework detected"],
    testFilePattern: "*",
    testDir: null,
  };
}
