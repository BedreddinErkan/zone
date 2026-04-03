import type { RepoFile } from "../types/project.js";

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

// ─── Main Validator ───────────────────────────────────────────────────────────

export function validateTestOutput(input: {
  featureContent?: string;
  stepDefinitionContent?: string;
  testFileContent?: string;
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
