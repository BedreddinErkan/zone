import type { RepoFile } from "../types/project.js";
import type { DetectedTestFramework } from "./detectTestFramework.js";

export interface TestEngineerContext {
  framework: DetectedTestFramework;
  existingTestFiles: RepoFile[];
  pageObjectFiles: RepoFile[];
  configFiles: RepoFile[];
  frameworkSummary: string;
  promptRole: string;
  outputRules: string[];
  fileLocationRules: string[];
}

function detectPageObjects(
  files: RepoFile[],
  language: string
): RepoFile[] {
  if (language === "java") {
    return files.filter(
      (f) =>
        f.path.includes("pages/") ||
        f.path.includes("page/") ||
        f.path.endsWith("Page.java") ||
        f.path.endsWith("PageObject.java")
    );
  }
  if (language === "typescript" || language === "javascript") {
    return files.filter(
      (f) =>
        f.path.includes("pages/") ||
        f.path.includes("page-objects/") ||
        f.path.endsWith(".page.ts") ||
        f.path.endsWith(".page.js")
    );
  }
  if (language === "python") {
    return files.filter(
      (f) =>
        f.path.includes("pages/") ||
        f.path.endsWith("_page.py") ||
        f.path.includes("page_objects/")
    );
  }
  return [];
}

function detectTestFiles(
  files: RepoFile[],
  framework: DetectedTestFramework
): RepoFile[] {
  switch (framework.framework) {
    case "playwright_ts":
      return files.filter(
        (f) => f.path.endsWith(".spec.ts") || f.path.endsWith(".test.ts")
      );
    case "playwright_js":
      return files.filter(
        (f) => f.path.endsWith(".spec.js") || f.path.endsWith(".test.js")
      );
    case "cypress":
      return files.filter(
        (f) => f.path.endsWith(".cy.ts") || f.path.endsWith(".cy.js")
      );
    case "cucumber_java":
      return files.filter(
        (f) => f.path.endsWith(".feature") || f.path.endsWith("Steps.java")
      );
    case "selenium_java":
    case "junit":
    case "testng":
      return files.filter((f) => f.path.endsWith("Test.java"));
    case "pytest":
    case "selenium_python":
      return files.filter(
        (f) => f.path.startsWith("test_") || f.path.includes("/test_")
      );
    default:
      return [];
  }
}

function detectConfigFiles(
  files: RepoFile[],
  framework: DetectedTestFramework
): RepoFile[] {
  return files.filter(
    (f) =>
      f.path.includes("playwright.config") ||
      f.path.includes("cypress.config") ||
      f.path.includes("pytest.ini") ||
      f.path.includes("testng.xml") ||
      f.path.includes("pom.xml") ||
      f.path.includes("conftest.py") ||
      f.path.includes("build.gradle")
  );
}

function buildFrameworkSummary(fw: DetectedTestFramework): string {
  const lines: string[] = [
    `Test framework: ${fw.framework}`,
    `Language: ${fw.language}`,
    `Confidence: ${fw.confidence}`,
    `Evidence: ${fw.evidence.join(", ")}`,
  ];
  if (fw.testDir) lines.push(`Test directory: ${fw.testDir}`);
  lines.push(`Test file pattern: ${fw.testFilePattern}`);
  return lines.join("\n");
}

function buildPromptRole(fw: DetectedTestFramework): string {
  switch (fw.framework) {
    case "playwright_ts":
      return "You are a senior test automation engineer specializing in Playwright with TypeScript. You write clean, maintainable end-to-end tests using the Page Object Model pattern.";
    case "playwright_js":
      return "You are a senior test automation engineer specializing in Playwright with JavaScript. You write clean, maintainable end-to-end tests using the Page Object Model pattern.";
    case "cypress":
      return "You are a senior test automation engineer specializing in Cypress. You write clean, maintainable end-to-end tests following Cypress best practices and custom command patterns.";
    case "cucumber_java":
      return "You are a senior test automation engineer specializing in Cucumber BDD with Java and Selenium WebDriver. You write Gherkin scenarios and Java step definitions using Page Object Model.";
    case "selenium_java":
      return "You are a senior test automation engineer specializing in Selenium WebDriver with Java. You write maintainable test classes using Page Object Model pattern.";
    case "testng":
      return "You are a senior test automation engineer specializing in TestNG with Java and Selenium WebDriver. You write test classes with TestNG annotations and Page Object Model.";
    case "pytest":
      return "You are a senior test automation engineer specializing in pytest with Python. You write clean, fixture-based tests following pytest best practices.";
    case "selenium_python":
      return "You are a senior test automation engineer specializing in Selenium WebDriver with Python. You write maintainable test classes using Page Object Model pattern.";
    default:
      return "You are a senior test automation engineer. You write clean, maintainable tests following best practices for the detected framework.";
  }
}

function buildOutputRules(fw: DetectedTestFramework): string[] {
  const common = [
    "Use ONLY methods and locators that exist in the provided page object files",
    "Do NOT invent new methods — if a method does not exist, mention it as a risk",
    "Follow the exact naming conventions used in existing test files",
    "Keep tests focused and minimal — one scenario per test where possible",
  ];

  switch (fw.framework) {
    case "playwright_ts":
    case "playwright_js":
      return [
        ...common,
        "Use async/await pattern throughout",
        "Use expect() from @playwright/test for assertions",
        "Use page.goto() for navigation",
        "Inject Page Objects via constructor",
      ];
    case "cypress":
      return [
        ...common,
        "Use cy.get() with data-testid selectors where possible",
        "Use cy.visit() for navigation",
        "Chain Cypress commands correctly",
        "Use custom commands from cypress/support if they exist",
      ];
    case "cucumber_java":
      return [
        ...common,
        "Write Gherkin in Given/When/Then format",
        "Use @Given @When @Then annotations in step definitions",
        "Inject Page Objects via constructor — never instantiate WebDriver directly",
        "Place feature files in src/test/resources/features/",
        "Place step definitions in src/test/java/ with correct package",
        "Use exact method signatures from provided page object files",
      ];
    case "selenium_java":
    case "testng":
      return [
        ...common,
        "Use @Test annotation for test methods",
        "Inject WebDriver via BaseTest or test base class if it exists",
        "Use explicit waits — never Thread.sleep()",
        "Follow existing package structure",
      ];
    case "pytest":
    case "selenium_python":
      return [
        ...common,
        "Use pytest fixtures for setup/teardown",
        "Use assert statements for assertions",
        "Follow existing conftest.py patterns",
        "Use snake_case for test function names",
      ];
    default:
      return common;
  }
}

function buildFileLocationRules(fw: DetectedTestFramework): string[] {
  switch (fw.framework) {
    case "playwright_ts":
      return [
        "Test files go in: tests/ or e2e/ directory",
        "Page objects go in: tests/pages/ or pages/",
        "File extension: .spec.ts",
      ];
    case "playwright_js":
      return [
        "Test files go in: tests/ or e2e/ directory",
        "Page objects go in: tests/pages/ or pages/",
        "File extension: .spec.js",
      ];
    case "cypress":
      return [
        "Test files go in: cypress/e2e/",
        "Page objects go in: cypress/pages/",
        "File extension: .cy.ts or .cy.js",
      ];
    case "cucumber_java":
      return [
        "Feature files go in: src/test/resources/features/",
        "Step definitions go in: src/test/java/<package>/stepdefinitions/",
        "Page objects go in: src/main/java/<package>/pages/",
      ];
    case "selenium_java":
    case "testng":
      return [
        "Test classes go in: src/test/java/<package>/",
        "Page objects go in: src/main/java/<package>/pages/",
        "File naming: <Name>Test.java",
      ];
    case "pytest":
    case "selenium_python":
      return [
        "Test files go in: tests/ directory",
        "Page objects go in: pages/ directory",
        "File naming: test_<name>.py",
      ];
    default:
      return ["Follow existing project structure"];
  }
}

export function buildTestEngineerContext(
  files: RepoFile[],
  framework: DetectedTestFramework
): TestEngineerContext {
  return {
    framework,
    existingTestFiles: detectTestFiles(files, framework),
    pageObjectFiles: detectPageObjects(files, framework.language),
    configFiles: detectConfigFiles(files, framework),
    frameworkSummary: buildFrameworkSummary(framework),
    promptRole: buildPromptRole(framework),
    outputRules: buildOutputRules(framework),
    fileLocationRules: buildFileLocationRules(framework),
  };
}