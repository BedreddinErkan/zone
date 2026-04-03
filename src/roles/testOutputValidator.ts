import type { RepoFile } from "../types/project.js";
import type { TestComplexity } from "./detectTestComplexity.js";

export type ValidationDecision = "pass" | "preview_only" | "blocked";

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
}

export interface ValidationResult {
  decision: ValidationDecision;
  issues: ValidationIssue[];
  summary: string;
}

// ─── Feature Validator ────────────────────────────────────────────────────────

function validateFeatureFile(content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = content.split("\n");

  // Placeholder URL kontrolü
  const placeholderUrls = ["example.com", "http://test.", "http://demo.", "localhost", "your-site.com"];
  for (const line of lines) {
    for (const url of placeholderUrls) {
      if (line.toLowerCase().includes(url)) {
        issues.push({
          code: "FEATURE_PLACEHOLDER_URL",
          severity: "warning",
          message: `Placeholder URL detected: "${line.trim()}"`,
        });
      }
    }
  }

  // Given/When/Then yapısı var mı?
  const hasGiven = lines.some(l => l.trim().startsWith("Given"));
  const hasWhen = lines.some(l => l.trim().startsWith("When"));
  const hasThen = lines.some(l => l.trim().startsWith("Then"));

  if (!hasGiven || !hasWhen || !hasThen) {
    issues.push({
      code: "FEATURE_MISSING_GWT",
      severity: "error",
      message: "Feature file is missing Given, When, or Then steps",
    });
  }

  // Scenario veya Scenario Outline var mı?
  const hasScenario = lines.some(l =>
    l.trim().startsWith("Scenario:") || l.trim().startsWith("Scenario Outline:")
  );
  if (!hasScenario) {
    issues.push({
      code: "FEATURE_MISSING_SCENARIO",
      severity: "error",
      message: "No Scenario or Scenario Outline found",
    });
  }

  // Boş Examples table kontrolü
  const examplesIdx = lines.findIndex(l => l.trim().startsWith("Examples:"));
  if (examplesIdx !== -1) {
    const afterExamples = lines.slice(examplesIdx + 1).filter(l => l.trim().length > 0);
    if (afterExamples.length < 2) {
      issues.push({
        code: "FEATURE_EMPTY_EXAMPLES",
        severity: "error",
        message: "Examples table is empty or missing data rows",
      });
    }
  }

  // Feature başlığı var mı?
  const hasFeature = lines.some(l => l.trim().startsWith("Feature:"));
  if (!hasFeature) {
    issues.push({
      code: "FEATURE_MISSING_HEADER",
      severity: "warning",
      message: "No Feature: header found",
    });
  }

  return issues;
}

// ─── Step Definition Validator ────────────────────────────────────────────────

function extractMethodCalls(javaContent: string): string[] {
  const methodCallRegex = /\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  const calls: string[] = [];
  let match;
  while ((match = methodCallRegex.exec(javaContent)) !== null) {
    calls.push(match[1]);
  }
  return calls;
}

function extractMethodDefinitions(javaContent: string): string[] {
  const methodDefRegex = /(?:public|private|protected)\s+\w+\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  const methods: string[] = [];
  let match;
  while ((match = methodDefRegex.exec(javaContent)) !== null) {
    methods.push(match[1]);
  }
  return methods;
}

function validateStepDefinitions(
  content: string,
  pageObjectContents: Array<{ path: string; content: string }>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // TODO/stub/placeholder kontrolü
  const todoPatterns = ["// TODO", "// FIXME", "// STUB", "throw new RuntimeException", "// implement"];
  for (const pattern of todoPatterns) {
    if (content.includes(pattern)) {
      issues.push({
        code: "STEP_DEF_STUB",
        severity: "warning",
        message: `Stub or placeholder found: "${pattern}"`,
      });
    }
  }

  // Package declaration var mı?
  if (!content.includes("package ")) {
    issues.push({
      code: "STEP_DEF_MISSING_PACKAGE",
      severity: "error",
      message: "Missing package declaration",
    });
  }

  // Import var mı?
  if (!content.includes("import ")) {
    issues.push({
      code: "STEP_DEF_MISSING_IMPORTS",
      severity: "warning",
      message: "No import statements found",
    });
  }

  // Page object method kontrolü
  if (pageObjectContents.length > 0) {
    const allPageObjectMethods = new Set<string>();
    for (const po of pageObjectContents) {
      const methods = extractMethodDefinitions(po.content);
      methods.forEach(m => allPageObjectMethods.add(m));
    }

    // Step def'te çağrılan methodlar
    const calledMethods = extractMethodCalls(content);

    // Bilinen Java/framework metodlarını filtrele
    const javaBuiltins = new Set([
      "assertEquals", "assertTrue", "assertFalse", "assertNotNull",
      "isDisplayed", "isEnabled", "click", "sendKeys", "getText",
      "findElement", "findElements", "get", "size", "toString",
      "equals", "contains", "isEmpty", "println", "format",
      "isResultsPageDisplayed", "openHomePage",
    ]);

    for (const method of calledMethods) {
      if (
        method.length > 3 &&
        !javaBuiltins.has(method) &&
        !allPageObjectMethods.has(method) &&
        !/^[A-Z]/.test(method) // constructor çağrısı değil
      ) {
        issues.push({
          code: "STEP_DEF_MISSING_PAGE_METHOD",
          severity: "warning",
          message: `Method "${method}" not found in page objects — may need to be implemented`,
        });
      }
    }
  }

  return issues;
}

function validatePlaywrightTest(content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lowerContent = content.toLowerCase();

  const placeholderSelectors = [
    "#username",
    "#password",
    "your-username",
    "your-password",
    "your-selector",
    "adjust selector",
    "adjust according",
    "#dashboard",
    "#home",
    "#main-content",
  ];

  for (const pattern of placeholderSelectors) {
    if (lowerContent.includes(pattern)) {
      issues.push({
        code: "PLAYWRIGHT_PLACEHOLDER_SELECTOR",
        severity: "warning",
        message: `Placeholder selector or guidance detected: "${pattern}"`,
      });
    }
  }

  if (!/\bexpect\s*\(/.test(content)) {
    issues.push({
      code: "PLAYWRIGHT_MISSING_ASSERTION",
      severity: "warning",
      message: "No expect() assertion found in Playwright test",
    });
  }

  if (/page\.goto\(\s*["'`]https?:\/\//.test(content)) {
    issues.push({
      code: "PLAYWRIGHT_HARDCODED_URL",
      severity: "warning",
      message: "page.goto() uses a hardcoded full URL instead of a relative path",
    });
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /(?:^|[^a-zA-Z0-9_])(?:page|[\w$.()[\]]+)\.(?:click|fill)\s*\(/.test(trimmed) &&
      !trimmed.startsWith("await ")
    ) {
      issues.push({
        code: "PLAYWRIGHT_MISSING_AWAIT",
        severity: "warning",
        message: `Missing await before Playwright action: "${trimmed}"`,
      });
    }
  }

  return issues;
}

function extractPythonImportedNames(content: string): Set<string> {
  const importedNames = new Set<string>();
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    const importMatch = trimmed.match(/^import\s+(.+)$/);
    if (importMatch) {
      const names = importMatch[1].split(",").map(name => name.trim());
      for (const name of names) {
        const baseName = name.split(/\s+as\s+/)[1] ?? name.split(".")[0];
        if (baseName) importedNames.add(baseName.trim());
      }
    }

    const fromImportMatch = trimmed.match(/^from\s+\S+\s+import\s+(.+)$/);
    if (fromImportMatch) {
      const names = fromImportMatch[1].split(",").map(name => name.trim());
      for (const name of names) {
        const importedName = name.split(/\s+as\s+/)[1] ?? name;
        if (importedName) importedNames.add(importedName.trim());
      }
    }
  }

  return importedNames;
}

function extractPytestFunctions(content: string): Array<{
  name: string;
  params: string[];
  body: string;
}> {
  const functions: Array<{ name: string; params: string[]; body: string }> = [];
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const headerMatch = lines[index].match(/^def\s+(test_[a-zA-Z0-9_]+)\s*\(([^)]*)\):\s*$/);
    if (!headerMatch) continue;

    const [, name, rawParams] = headerMatch;
    const bodyLines: string[] = [];
    let bodyIndex = index + 1;

    while (bodyIndex < lines.length) {
      const line = lines[bodyIndex];
      if (line.startsWith("def test_")) break;
      if (line.trim().length > 0 && !/^\s/.test(line)) break;
      bodyLines.push(line);
      bodyIndex += 1;
    }

    functions.push({
      name,
      params: rawParams
        .split(",")
        .map(param => param.trim())
        .filter(Boolean)
        .map(param => param.split("=")[0]?.trim())
        .filter(Boolean) as string[],
      body: bodyLines.join("\n"),
    });

    index = bodyIndex - 1;
  }

  return functions;
}

function validatePytestTest(content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lowerContent = content.toLowerCase();
  const importedNames = extractPythonImportedNames(content);
  const testFunctions = extractPytestFunctions(content);

  const placeholderCredentials = [
    "your-username",
    "your_username",
    "your-password",
    "your_password",
    "example_user",
    "test_user",
  ];

  for (const pattern of placeholderCredentials) {
    if (lowerContent.includes(pattern)) {
      issues.push({
        code: "PYTEST_PLACEHOLDER_CREDENTIALS",
        severity: "warning",
        message: `Placeholder credential detected: "${pattern}"`,
      });
    }
  }

  let hasAssert = false;

  for (const { name: testName, params, body } of testFunctions) {
    const availableNames = new Set<string>([
      ...params,
      ...importedNames,
      "self",
      "True",
      "False",
      "None",
    ]);

    const bodyLines = body.split("\n");
    for (const line of bodyLines) {
      const assignmentMatch = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
      if (assignmentMatch) {
        availableNames.add(assignmentMatch[1]);
      }
      if (/\bassert\b/.test(line)) {
        hasAssert = true;
      }
      if (/webdriver\.(?:Chrome|Firefox|Edge|Safari|Remote)\s*\(/.test(line)) {
        issues.push({
          code: "PYTEST_MISSING_FIXTURE_TEARDOWN",
          severity: "warning",
          message: `WebDriver created directly inside ${testName} instead of using a fixture`,
        });
      }
    }

    const variableUseRegex = /(?<!\.)\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\./g;
    let variableMatch: RegExpExecArray | null;
    while ((variableMatch = variableUseRegex.exec(body)) !== null) {
      const variableName = variableMatch[1];
      if (
        !availableNames.has(variableName) &&
        variableName !== "pytest" &&
        variableName !== "webdriver"
      ) {
        issues.push({
          code: "PYTEST_UNDEFINED_FIXTURE",
          severity: "warning",
          message: `Variable "${variableName}" is used in ${testName} but is not a fixture parameter or import`,
        });
      }
    }
  }

  if (!hasAssert) {
    issues.push({
      code: "PYTEST_MISSING_ASSERTION",
      severity: "warning",
      message: "No assert statement found in pytest test functions",
    });
  }

  return issues;
}

function validateSqlOutput(content: string, dialect: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const upperContent = content.toUpperCase();

  if (
    /\bDROP\s+TABLE\b/.test(upperContent) ||
    /\bTRUNCATE\s+TABLE\b/.test(upperContent) ||
    /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/.test(upperContent)
  ) {
    issues.push({
      code: "SQL_DESTRUCTIVE_OPERATION",
      severity: "error",
      message: `Destructive SQL operation detected for dialect ${dialect || "unknown"}`,
    });
  }

  const placeholders = [
    "your_table",
    "example_table",
    "my_table",
    "column_name",
    "your_column",
  ];

  for (const placeholder of placeholders) {
    if (content.toLowerCase().includes(placeholder)) {
      issues.push({
        code: "SQL_PLACEHOLDER",
        severity: "warning",
        message: `Placeholder SQL identifier detected: "${placeholder}"`,
      });
    }
  }

  const createTableRegex = /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i;
  if (createTableRegex.test(content)) {
    issues.push({
      code: "SQL_MISSING_IF_NOT_EXISTS",
      severity: "warning",
      message: "CREATE TABLE is missing IF NOT EXISTS",
    });
  }

  const snakeCaseViolationRegex = /CREATE\s+TABLE[\s\S]*?[a-z][A-Z]|^\s*[a-z_][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*\s+/m;
  if (snakeCaseViolationRegex.test(content)) {
    issues.push({
      code: "SQL_SNAKE_CASE_VIOLATION",
      severity: "warning",
      message: "CamelCase table or column naming detected in SQL schema",
    });
  }

  const createTableBlockRegex =
    /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?[\s\S]*?\(([\s\S]*?)\)/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = createTableBlockRegex.exec(content)) !== null) {
    if (!/PRIMARY\s+KEY/i.test(blockMatch[1])) {
      issues.push({
        code: "SQL_MISSING_PRIMARY_KEY",
        severity: "warning",
        message: "CREATE TABLE block is missing a PRIMARY KEY",
      });
    }
  }

  return issues;
}

function validateComplexity(
  content: string,
  framework: string,
  complexity: TestComplexity
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lowerContent = content.toLowerCase();

  if (complexity === "data_driven") {
    if (
      (framework === "pytest" || framework === "selenium_python") &&
      !content.includes("@pytest.mark.parametrize")
    ) {
      issues.push({
        code: "COMPLEXITY_MISSING_PARAMETRIZE",
        severity: "warning",
        message: "Data-driven pytest test is missing @pytest.mark.parametrize",
      });
    }

    if (
      framework === "cucumber_java" &&
      !content.includes("Scenario Outline")
    ) {
      issues.push({
        code: "COMPLEXITY_MISSING_PARAMETRIZE",
        severity: "warning",
        message: "Data-driven Cucumber test is missing Scenario Outline",
      });
    }

    if (
      (framework === "playwright_ts" || framework === "playwright_js") &&
      !content.includes("test.each") &&
      !content.includes("forEach")
    ) {
      issues.push({
        code: "COMPLEXITY_MISSING_PARAMETRIZE",
        severity: "warning",
        message: "Data-driven Playwright test is missing test.each or forEach",
      });
    }
  }

  if (
    complexity === "negative" &&
    !lowerContent.includes("error") &&
    !lowerContent.includes("invalid") &&
    !lowerContent.includes("fail")
  ) {
    issues.push({
      code: "COMPLEXITY_MISSING_NEGATIVE_CASE",
      severity: "warning",
      message: "Negative test intent detected but no error/invalid/fail case found in generated content",
    });
  }

  return issues;
}

// ─── Main Validator ───────────────────────────────────────────────────────────

export function validateTestOutput(input: {
  featureContent?: string;
  stepDefinitionContent?: string;
  testFileContent?: string;
  sqlContent?: string;
  sqlDialect?: string;
  complexityHint?: TestComplexity;
  pageObjectContents?: Array<{ path: string; content: string }>;
  framework: string;
}): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (input.featureContent) {
    issues.push(...validateFeatureFile(input.featureContent));
  }

  if (input.stepDefinitionContent) {
    issues.push(
      ...validateStepDefinitions(
        input.stepDefinitionContent,
        input.pageObjectContents ?? []
      )
    );
  }

  if (
    (input.framework === "playwright_ts" || input.framework === "playwright_js") &&
    (input.testFileContent || input.featureContent)
  ) {
    issues.push(
      ...validatePlaywrightTest(input.testFileContent ?? input.featureContent ?? "")
    );
  }

  if (
    (input.framework === "pytest" || input.framework === "selenium_python") &&
    input.testFileContent
  ) {
    issues.push(...validatePytestTest(input.testFileContent));
  }

  if (input.sqlContent) {
    issues.push(...validateSqlOutput(input.sqlContent, input.sqlDialect ?? "unknown"));
  }

  if (input.complexityHint) {
    const complexityContent =
      input.testFileContent ??
      input.featureContent ??
      input.stepDefinitionContent ??
      "";
    issues.push(
      ...validateComplexity(
        complexityContent,
        input.framework,
        input.complexityHint
      )
    );
  }

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");

  let decision: ValidationDecision;
  if (errors.length > 0) {
    decision = "blocked";
  } else if (warnings.length > 0) {
    decision = "preview_only";
  } else {
    decision = "pass";
  }

  const summary =
    decision === "pass"
      ? "Validation passed — output is safe to apply"
      : decision === "preview_only"
      ? `Validation warnings (${warnings.length}) — review before applying`
      : `Validation blocked (${errors.length} error(s)) — cannot apply`;

  return { decision, issues, summary };
}
