import path from "node:path";
import type { RepoFile } from "../types/project.js";
import type { DetectedTestFramework } from "./detectTestFramework.js";

export interface TestEngineerContext {
  framework: DetectedTestFramework;
  existingTestFiles: RepoFile[];
  pageObjectFiles: RepoFile[];
  stepDefinitionFiles: RepoFile[];
  featureFiles: RepoFile[];
  configFiles: RepoFile[];
  frameworkSummary: string;
  promptRole: string;
  outputRules: string[];
  fileLocationRules: string[];
  outputPaths: {
    testFile: string;
    stepDefinition?: string;
    featureFile?: string;
  };
}

function detectPageObjects(files: RepoFile[], language: string): RepoFile[] {
  if (!Array.isArray(files)) return [];
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

function detectStepDefinitions(files: RepoFile[]): RepoFile[] {
  if (!Array.isArray(files)) return [];
  return files.filter(
    (f) =>
      f.path.includes("steps/") ||
      f.path.includes("stepdefinitions/") ||
      f.path.includes("step_definitions/") ||
      f.path.endsWith("Steps.java") ||
      f.path.endsWith("_steps.py")
  );
}

function detectFeatureFiles(files: RepoFile[]): RepoFile[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f) => f.path.endsWith(".feature"))
    .sort((a, b) => {
      const aIsPreferred = a.path.startsWith("src/test/resources/features/");
      const bIsPreferred = b.path.startsWith("src/test/resources/features/");
      if (aIsPreferred === bIsPreferred) return a.path.localeCompare(b.path);
      return aIsPreferred ? -1 : 1;
    });
}

function detectTestFiles(
  files: RepoFile[],
  framework: DetectedTestFramework
): RepoFile[] {
  if (!Array.isArray(files)) return [];
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
  if (!Array.isArray(files)) return [];
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
      return "You are a senior test automation engineer specializing in Playwright with TypeScript.";
    case "playwright_js":
      return "You are a senior test automation engineer specializing in Playwright with JavaScript.";
    case "cypress":
      return "You are a senior test automation engineer specializing in Cypress.";
    case "cucumber_java":
      return "You are a senior test automation engineer specializing in Cucumber BDD with Java and Selenium WebDriver. You write Gherkin scenarios and Java step definitions using Page Object Model.";
    case "selenium_java":
      return "You are a senior test automation engineer specializing in Selenium WebDriver with Java.";
    case "testng":
      return "You are a senior test automation engineer specializing in TestNG with Java and Selenium WebDriver.";
    case "pytest":
      return "You are a senior test automation engineer specializing in pytest with Python.";
    case "selenium_python":
      return "You are a senior test automation engineer specializing in Selenium WebDriver with Python.";
    default:
      return "You are a senior test automation engineer.";
  }
}

function buildOutputRules(fw: DetectedTestFramework): string[] {
  const common = [
    "Use ONLY methods that exist in the provided page object files",
    "Do NOT invent new methods — if a method does not exist, mention it as a risk",
    "Follow the exact naming conventions used in existing test files",
    "Keep tests focused and minimal",
  ];
  switch (fw.framework) {
    case "playwright_ts":
    case "playwright_js":
      return [...common, "Use async/await pattern", "Use expect() from @playwright/test"];
    case "cypress":
      return [...common, "Use cy.get() with data-testid selectors", "Use cy.visit() for navigation"];
    case "cucumber_java":
      return [
        ...common,
        "Write Gherkin in Given/When/Then format",
        "Use @Given @When @Then annotations",
        "Inject Page Objects via constructor — NEVER instantiate WebDriver directly",
        "Place feature files in src/test/resources/features/",
        "Place step definitions in src/test/java/ with correct package",
        "ALWAYS use export default ClassName not export default new ClassName()",
      ];
    case "selenium_java":
    case "testng":
      return [...common, "Use @Test annotation", "Use explicit waits — never Thread.sleep()"];
    case "pytest":
    case "selenium_python":
      return [...common, "Use pytest fixtures", "Use assert statements"];
    default:
      return common;
  }
}

function buildFileLocationRules(fw: DetectedTestFramework): string[] {
  switch (fw.framework) {
    case "playwright_ts":
      return ["Test files: tests/ or e2e/", "Extension: .spec.ts"];
    case "playwright_js":
      return ["Test files: tests/ or e2e/", "Extension: .spec.js"];
    case "cypress":
      return ["Test files: cypress/e2e/", "Extension: .cy.ts or .cy.js"];
    case "cucumber_java":
      return [
        "Feature files: src/test/resources/features/",
        "Step definitions: src/test/java/<package>/stepdefinitions/",
        "Page objects: src/main/java/<package>/pages/",
      ];
    case "selenium_java":
    case "testng":
      return ["Test classes: src/test/java/<package>/", "Naming: <Name>Test.java"];
    case "pytest":
    case "selenium_python":
      return ["Test files: tests/", "Naming: test_<name>.py"];
    default:
      return ["Follow existing project structure"];
  }
}

const TASK_FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "please",
  "write",
  "new",
  "cucumber",
  "scenario",
  "for",
  "test",
  "create",
  "generate",
  "feature",
]);

function buildIntentTokens(task: string): string[] {
  const sanitizedTask = task
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const rawTokens = sanitizedTask.split(/\s+/).filter(Boolean);
  const meaningfulTokens = rawTokens.filter(
    (token) => !TASK_FILLER_WORDS.has(token)
  );
  const sourceTokens = meaningfulTokens.length > 0 ? meaningfulTokens : rawTokens;
  const limitedTokens: string[] = [];
  let totalLength = 0;

  for (const token of sourceTokens) {
    const nextLength = totalLength === 0 ? token.length : totalLength + 1 + token.length;
    if (limitedTokens.length >= 5 || nextLength > 40) {
      break;
    }
    limitedTokens.push(token);
    totalLength = nextLength;
  }

  return limitedTokens.length > 0 ? limitedTokens : ["generated", "test"];
}

function buildOutputNameParts(task: string): { slug: string; pascal: string } {
  const tokens = buildIntentTokens(task);
  const slug = tokens.join("_");
  const pascal = tokens
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join("");

  return { slug, pascal };
}

function findExistingDirectory(
  files: RepoFile[],
  matcher: (file: RepoFile) => boolean
): string | null {
  const existingFile = [...files]
    .sort((a, b) => {
      const aIsPreferred = a.path.startsWith("src/test/resources/features/");
      const bIsPreferred = b.path.startsWith("src/test/resources/features/");
      if (aIsPreferred === bIsPreferred) return a.path.localeCompare(b.path);
      return aIsPreferred ? -1 : 1;
    })
    .find(matcher);
  return existingFile ? path.posix.dirname(existingFile.path) : null;
}

function buildOutputPaths(
  task: string,
  fw: DetectedTestFramework,
  files: RepoFile[]
): TestEngineerContext["outputPaths"] {
  const { slug, pascal } = buildOutputNameParts(task);
  const base = fw.testDir ?? "tests";

  switch (fw.framework) {
    case "playwright_ts":
      return { testFile: `${base}/${slug}.spec.ts` };
    case "playwright_js":
      return { testFile: `${base}/${slug}.spec.js` };
    case "cypress":
      return { testFile: `cypress/e2e/${slug}.cy.ts` };
    case "cucumber_java": {
      const featureDir =
        findExistingDirectory(files, (file) => file.path.endsWith(".feature")) ??
        fw.testDir ??
        "src/test/resources/features";
      const stepDefinitionDir =
        findExistingDirectory(files, (file) => file.path.endsWith("Steps.java")) ??
        "src/test/java/com/stepdefinitions";

      return {
        testFile: `${featureDir}/${slug}.feature`,
        featureFile: `${featureDir}/${slug}.feature`,
        stepDefinition: `${stepDefinitionDir}/${pascal}Steps.java`,
      };
    }
    case "selenium_java":
    case "testng":
      return { testFile: `src/test/java/${pascal}Test.java` };
    case "pytest":
    case "selenium_python":
      return { testFile: `tests/test_${slug}.py` };
    default:
      return { testFile: `tests/${slug}.test` };
  }
}

export function buildTestEngineerContext(
  task: string,
  framework: DetectedTestFramework,
  files: RepoFile[]
): TestEngineerContext {
  const safeFiles = Array.isArray(files) ? files : [];
  const existingTestFiles = detectTestFiles(safeFiles, framework);
  const pageObjectFiles = detectPageObjects(safeFiles, framework.language);
  const stepDefinitionFiles = detectStepDefinitions(safeFiles);
  const featureFiles = detectFeatureFiles(safeFiles);
  const configFiles = detectConfigFiles(safeFiles, framework);

  return {
    framework,
    existingTestFiles,
    pageObjectFiles,
    stepDefinitionFiles,
    featureFiles,
    configFiles,
    frameworkSummary: buildFrameworkSummary(framework),
    promptRole: buildPromptRole(framework),
    outputRules: buildOutputRules(framework),
    fileLocationRules: buildFileLocationRules(framework),
    outputPaths: buildOutputPaths(task, framework, safeFiles),
  };
}
