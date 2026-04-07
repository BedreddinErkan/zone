// validateLlmOutput.ts
// Role-aware, deterministic LLM output content validator.
// Checks generated code quality BEFORE it reaches applyPatchPlan.
// No LLM calls, no async — pure rule-based, always same input → same output.

export type LlmOutputRole = "test_engineer" | "developer" | "data_analyst";

export type LlmOutputSeverity = "warning" | "error";

export type LlmOutputIssue = {
  code: string;
  severity: LlmOutputSeverity;
  message: string;
  filePath?: string;
};

export type LlmOutputValidationResult = {
  /** true = output passed all checks (warnings may still exist) */
  valid: boolean;
  /** "ok" | "warn" | "block" — maps to Zone execution modes */
  verdict: "ok" | "warn" | "block";
  issues: LlmOutputIssue[];
};

type PatchContentItem = {
  filePath: string;
  content: string;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function issue(
  code: string,
  severity: LlmOutputSeverity,
  message: string,
  filePath?: string
): LlmOutputIssue {
  return { code, severity, message, filePath };
}

function hasPattern(content: string, pattern: RegExp): boolean {
  return pattern.test(content);
}

function countMatches(content: string, pattern: RegExp): number {
  return (content.match(pattern) ?? []).length;
}

// ---------------------------------------------------------------------------
// Test Engineer rules
// ---------------------------------------------------------------------------

function validateTestEngineerOutput(patches: PatchContentItem[]): LlmOutputIssue[] {
  const issues: LlmOutputIssue[] = [];

  for (const patch of patches) {
    const c = patch.content;
    const fp = patch.filePath;

    // Only validate test files
    if (!fp.match(/\.(spec|test)\.(ts|js|tsx|jsx)$/) && !fp.includes("cypress") && !fp.includes("playwright")) {
      continue;
    }

    // MISSING_EXPECT: no assertion found
    const hasExpect = hasPattern(c, /expect\s*\(/);
    const hasCyAssert = hasPattern(c, /cy\.(should|contains|have)\b/);
    const hasAssert = hasPattern(c, /assert\s*\./);
    if (!hasExpect && !hasCyAssert && !hasAssert) {
      issues.push(issue(
        "MISSING_EXPECT",
        "error",
        "Test file contains no expect(), cy.should(), or assert — output is not a valid test.",
        fp
      ));
    }

    // MISSING_AWAIT: async test body has no await
    const isAsync = hasPattern(c, /async\s+(function|\(|[a-zA-Z_])/);
    const hasAwait = hasPattern(c, /\bawait\b/);
    if (isAsync && !hasAwait) {
      issues.push(issue(
        "MISSING_AWAIT",
        "error",
        "Async test function found but no await keyword — likely missing async calls.",
        fp
      ));
    }

    // PLACEHOLDER_SELECTOR: generic/placeholder CSS selectors
    const placeholderSelectors = [
      /getByText\(['"`]TODO/i,
      /getByText\(['"`]PLACEHOLDER/i,
      /querySelector\(['"`]\.todo/i,
      /\[data-testid=['"`]todo/i,
      /\[data-testid=['"`]placeholder/i,
      /#placeholder/i,
      /\.todo-class/i,
    ];
    for (const p of placeholderSelectors) {
      if (hasPattern(c, p)) {
        issues.push(issue(
          "PLACEHOLDER_SELECTOR",
          "error",
          "Test contains placeholder selector — not safe to apply as-is.",
          fp
        ));
        break;
      }
    }

    // HARDCODED_URL: absolute URLs in tests (should use fixtures/env vars)
    if (hasPattern(c, /https?:\/\/(localhost|127\.0\.0\.1|example\.com|your-app)/i)) {
      issues.push(issue(
        "HARDCODED_URL",
        "warning",
        "Test contains hardcoded URL — consider using base URL config or env variable.",
        fp
      ));
    }

    // EMPTY_TEST_BODY: it/test block with empty body
    if (hasPattern(c, /\b(it|test)\s*\([^)]+,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}/)) {
      issues.push(issue(
        "EMPTY_TEST_BODY",
        "error",
        "Empty test body detected — test will pass trivially and provides no coverage.",
        fp
      ));
    }

    // TOO_FEW_ASSERTIONS: test blocks vs expect calls ratio is suspicious
    const testBlockCount = countMatches(c, /\b(it|test)\s*\(/g);
    const expectCount = countMatches(c, /expect\s*\(/g);
    if (testBlockCount > 0 && expectCount > 0 && expectCount < testBlockCount) {
      issues.push(issue(
        "LOW_ASSERTION_RATIO",
        "warning",
        `Found ${testBlockCount} test block(s) but only ${expectCount} expect call(s) — some tests may lack assertions.`,
        fp
      ));
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Developer rules
// ---------------------------------------------------------------------------

function validateDeveloperOutput(patches: PatchContentItem[]): LlmOutputIssue[] {
  const issues: LlmOutputIssue[] = [];

  for (const patch of patches) {
    const c = patch.content;
    const fp = patch.filePath;

    // GENERIC_TEMPLATE: LLM boilerplate markers
    const templateMarkers = [
      /\/\/\s*TODO[:：]/i,
      /\/\/\s*FIXME[:：]/i,
      /\/\/\s*your (code|logic|implementation) here/i,
      /\/\*\s*implement\s*(this|me|here)\s*\*\//i,
      /throw new Error\(['"`]not implemented/i,
      /console\.log\(['"`](hello world|test|debug|TODO)/i,
    ];
    for (const p of templateMarkers) {
      if (hasPattern(c, p)) {
        issues.push(issue(
          "GENERIC_TEMPLATE",
          "warning",
          "Output contains template/placeholder markers — review before applying.",
          fp
        ));
        break;
      }
    }

    // FULL_UI_OVERWRITE: entire component replaced with generic shell
    const isUiFile = fp.match(/\.(tsx|jsx)$/);
    if (isUiFile) {
      const hasRealImports = hasPattern(c, /^import .+ from ['"`]/m);
      const lineCount = c.split("\n").length;
      const isShell = lineCount < 15 && !hasRealImports;
      if (isShell) {
        issues.push(issue(
          "FULL_UI_OVERWRITE",
          "error",
          "UI file appears to be a minimal shell (< 15 lines, no imports) — likely a full overwrite with generic template.",
          fp
        ));
      }
    }

    // MISSING_IMPORTS: usage of identifiers that look unimported
    // Heuristic: file uses React hooks but no React/hooks import
    const usesUseState = hasPattern(c, /\buseState\s*\(/);
    const usesUseEffect = hasPattern(c, /\buseEffect\s*\(/);
    const hasReactImport = hasPattern(c, /import.*(?:React|useState|useEffect).*from ['"`]react['"`]/);
    if ((usesUseState || usesUseEffect) && !hasReactImport) {
      issues.push(issue(
        "MISSING_REACT_IMPORT",
        "error",
        "File uses React hooks (useState/useEffect) but is missing React import.",
        fp
      ));
    }

    // BROKEN_EXPORT: file has no export at all (likely truncated or incomplete)
    const isModuleFile = fp.match(/\.(ts|tsx|js|jsx)$/);
    if (isModuleFile && !hasPattern(c, /\bexport\b/)) {
      issues.push(issue(
        "NO_EXPORT",
        "warning",
        "File has no export statement — may be incomplete or truncated.",
        fp
      ));
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Data Analyst rules
// ---------------------------------------------------------------------------

function validateDataAnalystOutput(patches: PatchContentItem[]): LlmOutputIssue[] {
  const issues: LlmOutputIssue[] = [];

  for (const patch of patches) {
    const c = patch.content;
    const fp = patch.filePath;

    // Only check SQL files and migration files
    const isSqlFile = fp.match(/\.(sql)$/) || fp.includes("migration") || fp.includes("seed");
    const hasSqlContent = hasPattern(c, /\b(SELECT|INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i);
    if (!isSqlFile && !hasSqlContent) continue;

    // UNSAFE_DROP: DROP TABLE without IF EXISTS guard
    if (hasPattern(c, /DROP\s+TABLE\s+(?!IF\s+EXISTS)/i)) {
      issues.push(issue(
        "UNSAFE_DROP",
        "error",
        "DROP TABLE without IF EXISTS — destructive operation that may fail on missing table.",
        fp
      ));
    }

    // TRUNCATE_DETECTED: always block
    if (hasPattern(c, /\bTRUNCATE\b/i)) {
      issues.push(issue(
        "TRUNCATE_DETECTED",
        "error",
        "TRUNCATE detected — irreversible bulk delete. Manual review required.",
        fp
      ));
    }

    // UNBOUNDED_DELETE: DELETE without WHERE clause
    if (hasPattern(c, /DELETE\s+FROM\s+\w+\s*(?:;|$)/im) &&
        !hasPattern(c, /DELETE\s+FROM\s+\w+\s+WHERE/i)) {
      issues.push(issue(
        "UNBOUNDED_DELETE",
        "error",
        "DELETE statement without WHERE clause — will delete ALL rows in the table.",
        fp
      ));
    }

    // UNBOUNDED_UPDATE: UPDATE without WHERE clause
    if (hasPattern(c, /UPDATE\s+\w+\s+SET\b/i) &&
        !hasPattern(c, /UPDATE\s+\w+\s+SET[\s\S]+?WHERE/i)) {
      issues.push(issue(
        "UNBOUNDED_UPDATE",
        "error",
        "UPDATE statement without WHERE clause — will update ALL rows in the table.",
        fp
      ));
    }

    // MISSING_ROLLBACK: migration file with no rollback/down section
    const isMigration = fp.includes("migration");
    if (isMigration && !hasPattern(c, /\b(rollback|down|revert)\b/i)) {
      issues.push(issue(
        "MISSING_ROLLBACK",
        "warning",
        "Migration file appears to have no rollback/down section.",
        fp
      ));
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

function computeVerdict(issues: LlmOutputIssue[]): "ok" | "warn" | "block" {
  if (issues.some((i) => i.severity === "error")) return "block";
  if (issues.some((i) => i.severity === "warning")) return "warn";
  return "ok";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates LLM-generated patch content for a given role.
 * Deterministic: same input always produces same output.
 * No side effects, no async, no LLM calls.
 *
 * @param role    - The Zone role that generated this output.
 * @param patches - Array of { filePath, content } from the LLM patch.
 * @returns       LlmOutputValidationResult with verdict and issues.
 */
export function validateLlmOutput(
  role: LlmOutputRole,
  patches: PatchContentItem[]
): LlmOutputValidationResult {
  let issues: LlmOutputIssue[] = [];

  switch (role) {
    case "test_engineer":
      issues = validateTestEngineerOutput(patches);
      break;
    case "developer":
      issues = validateDeveloperOutput(patches);
      break;
    case "data_analyst":
      issues = validateDataAnalystOutput(patches);
      break;
  }

  const verdict = computeVerdict(issues);

  return {
    valid: verdict !== "block",
    verdict,
    issues,
  };
}