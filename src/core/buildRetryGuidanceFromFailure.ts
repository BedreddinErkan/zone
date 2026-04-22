export type FailureAnalysis = {
  expected: string;
  actual: string;
  failureType: NormalizedFailureReason;
  rootCause: string;
  incorrectAssumption: string;
  realBehavior: string;
  fixStrategy: string;
};

export type NormalizedFailureReason =
  | "assertion_mismatch"
  | "syntax_error"
  | "type_error"
  | "lint_error"
  | "runtime_error"
  | "missing_dependency"
  | "verification_timeout"
  | "unsupported_behavior_assumption"
  | "wrong_repo_assumption"
  | "verification_failure";

export type RetryGuidanceBrief = {
  failedTarget: string;
  normalizedFailureReason: NormalizedFailureReason;
  rootCause: string;
  expected: string;
  actual: string;
  incorrectAssumption: string;
  realBehavior: string;
  requiredFix: string;
  fixStrategy: string;
  constraint: string;
  nextAttemptConstraint: string;
  minimalPatchDiscipline: string;
  scopeConstraint: string;
  failureSignature: string;
  repeatedFailure: boolean;
  strictness: "normal" | "strict" | "escalated";
};

function firstMatch(value: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate.slice(0, 240);
  }
  return "";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeReason(message: string): NormalizedFailureReason {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("ts2322") ||
    normalized.includes("ts2339") ||
    normalized.includes("ts2304") ||
    normalized.includes("typeerror:") ||
    normalized.includes("type error") ||
    normalized.includes("is not assignable to type") ||
    normalized.includes("property") && normalized.includes("does not exist on type")
  ) {
    return "type_error";
  }
  if (
    normalized.includes("expected") ||
    normalized.includes("received") ||
    normalized.includes("tohave") ||
    normalized.includes("tocontain") ||
    normalized.includes("assertionerror") ||
    normalized.includes("assertion failed")
  ) {
    return "assertion_mismatch";
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "verification_timeout";
  }
  if (
    normalized.includes("eslint") ||
    normalized.includes("lint") ||
    normalized.includes("prettier") ||
    normalized.includes("no-unused-vars") ||
    normalized.includes("no-undef")
  ) {
    return "lint_error";
  }
  if (
    normalized.includes("cannot find module") ||
    normalized.includes("module not found") ||
    normalized.includes("cannot resolve") ||
    normalized.includes("could not resolve") ||
    normalized.includes("missing dependency")
  ) {
    return "missing_dependency";
  }
  if (normalized.includes("syntaxerror") || normalized.includes("unexpected token")) {
    return "syntax_error";
  }
  if (
    normalized.includes("enoent") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("path does not exist") ||
    normalized.includes("file not found")
  ) {
    return "wrong_repo_assumption";
  }
  if (
    normalized.includes("locator") ||
    normalized.includes("selector") ||
    normalized.includes("unsupported") ||
    normalized.includes("not visible") ||
    normalized.includes("not found")
  ) {
    return "unsupported_behavior_assumption";
  }
  if (
    normalized.includes("referenceerror") ||
    normalized.includes("rangeerror") ||
    normalized.includes("uncaught") ||
    normalized.includes("exception") ||
    normalized.includes("failed to execute")
  ) {
    return "runtime_error";
  }
  if (normalized.includes("parse error") || normalized.includes("unterminated")) {
    return "syntax_error";
  }
  return "verification_failure";
}

function extractExpected(message: string): string {
  return firstMatch(message, [
    /Expected(?:\s+string)?:\s*["'`]?([^"'`\n]+)["'`]?/i,
    /Expected:\s*([^\n]+)/i,
    /expect(?:ed)?(?:\s+[^"'`\n]+)?\s+["'`]([^"'`\n]+)["'`]/i,
    /toContainText\(\s*["'`]([^"'`]+)["'`]\s*\)/i,
    /toHaveText\(\s*["'`]([^"'`]+)["'`]\s*\)/i,
    /toHaveURL\(\s*["'`]([^"'`]+)["'`]\s*\)/i,
    /expected\s+["'`]([^"'`]+)["'`]\s+(?:to equal|to be|to contain)/i,
  ]);
}

function extractActual(message: string): string {
  return firstMatch(message, [
    /Received(?:\s+string)?:\s*["'`]?([^"'`\n]+)["'`]?/i,
    /Received:\s*([^\n]+)/i,
    /but got\s+["'`]([^"'`\n]+)["'`]/i,
    /actual(?:\s+[^"'`\n]+)?\s+["'`]([^"'`\n]+)["'`]/i,
    /locator resolved to\s+([^\n]+)/i,
    /got\s+["'`]([^"'`\n]+)["'`]/i,
  ]);
}

function extractIncorrectAssumption(
  message: string,
  reason: NormalizedFailureReason,
  expected: string,
  actual: string
): string {
  if (expected && actual) {
    return `The previous attempt assumed "${expected}", but verification observed "${actual}".`;
  }

  if (/locked[_ -]?out/i.test(message) && /invalid credentials|invalid username|invalid password/i.test(message)) {
    return "The previous attempt assumed the user was locked out, but the app reported invalid credentials.";
  }

  if (expected) {
    return `The previous attempt introduced or kept an expectation for "${expected}" without confirming the app behavior.`;
  }

  if (reason === "wrong_repo_assumption") {
    return "The previous attempt assumed files, paths, or project structure that do not exist in this repo.";
  }

  if (reason === "missing_dependency") {
    return "The previous attempt assumed a dependency or module was available when verification showed it was not.";
  }

  if (reason === "unsupported_behavior_assumption") {
    return "The previous attempt assumed unsupported UI/API behavior instead of matching the repo's actual behavior.";
  }

  return "The previous attempt introduced a failing expectation or unsupported implementation detail.";
}

function buildRootCause(reason: NormalizedFailureReason, expected: string, actual: string): string {
  if (reason === "assertion_mismatch" && expected && actual) {
    return "The generated patch/test assertion does not match the behavior observed during verification.";
  }
  if (reason === "assertion_mismatch") {
    return "The generated patch/test assertion is not aligned with the verification output.";
  }
  if (reason === "unsupported_behavior_assumption") {
    return "The generated patch/test uses a selector or locator that does not match the current app.";
  }
  if (reason === "verification_timeout") {
    return "The generated patch/test waits for behavior that was not reached during verification.";
  }
  if (reason === "missing_dependency") {
    return "The generated patch references a module or path that is unavailable in the repo.";
  }
  if (reason === "type_error") {
    return "The generated patch introduced a type contract mismatch.";
  }
  if (reason === "lint_error") {
    return "The generated patch violates the repo's static linting rules.";
  }
  if (reason === "runtime_error") {
    return "The generated patch caused runtime execution to fail.";
  }
  if (reason === "wrong_repo_assumption") {
    return "The generated patch assumed files, paths, scripts, or repo structure that verification could not find.";
  }
  if (reason === "syntax_error") {
    return "The generated patch introduced code that cannot be parsed.";
  }
  return "Verification failed after the generated patch, so the next attempt must correct the concrete failure.";
}

function buildRealBehavior(actual: string, reason: NormalizedFailureReason): string {
  if (actual) return `Observed behavior/output: "${actual}".`;
  if (reason === "verification_timeout") return "Observed behavior: the expected condition was not reached before timeout.";
  if (reason === "unsupported_behavior_assumption") return "Observed behavior: the requested selector, API, or behavior was not found or was unstable.";
  if (reason === "wrong_repo_assumption") return "Observed behavior: verification could not find the assumed repo file, path, script, or structure.";
  return "Observed behavior: verification rejected the previous generated output.";
}

function buildRequiredFix(reason: NormalizedFailureReason, expected: string, actual: string): string {
  if (reason === "assertion_mismatch" && actual) {
    return `Update the failing assertion/test expectation to match the observed behavior "${actual}" unless the original task explicitly requires changing app behavior.`;
  }
  if (reason === "assertion_mismatch" && expected) {
    return `Re-check the expectation for "${expected}" and correct the generated test or patch so it matches real app behavior.`;
  }
  if (reason === "unsupported_behavior_assumption") {
    return "Use behavior, selectors, APIs, or test expectations that are actually present in the repository context.";
  }
  if (reason === "verification_timeout") {
    return "Remove the unsupported wait/expectation or switch to a behavior that the app actually exposes.";
  }
  if (reason === "missing_dependency") {
    return "Replace the missing import/dependency with one that exists in the repository or add the minimal supported dependency change if explicitly required.";
  }
  if (reason === "type_error") {
    return "Align the changed code with the existing TypeScript/type contract using the smallest local correction.";
  }
  if (reason === "lint_error") {
    return "Fix the reported lint violation without changing unrelated behavior.";
  }
  if (reason === "runtime_error") {
    return "Fix the concrete runtime exception at its local source instead of masking it.";
  }
  if (reason === "wrong_repo_assumption") {
    return "Re-target the patch to files, scripts, and paths that exist in this repository.";
  }
  if (reason === "syntax_error") {
    return "Fix the syntax error with the smallest valid code change.";
  }
  return "Make a concrete patch that addresses the verification failure; do not return an unchanged result.";
}

function buildFixStrategy(reason: NormalizedFailureReason): string {
  if (reason === "assertion_mismatch") {
    return "Prefer fixing the assertion/test expectation first; only change production logic if the task explicitly asks for behavior change.";
  }
  if (reason === "unsupported_behavior_assumption") {
    return "Inspect existing repo behavior and choose a supported selector, API, fixture, or expectation.";
  }
  if (reason === "verification_timeout") {
    return "Narrow the test flow and assert a reachable state instead of adding longer waits.";
  }
  if (reason === "missing_dependency") {
    return "Reuse existing modules and local paths; avoid introducing new dependencies.";
  }
  if (reason === "type_error") {
    return "Preserve existing types and adapt only the mismatched callsite or declaration.";
  }
  if (reason === "lint_error") {
    return "Apply a style/static-analysis correction only where lint reported it.";
  }
  if (reason === "runtime_error") {
    return "Trace the failing runtime path and patch the smallest responsible branch.";
  }
  if (reason === "wrong_repo_assumption") {
    return "Re-scan the provided repo context and avoid invented files, commands, or paths.";
  }
  if (reason === "syntax_error") {
    return "Keep the correction minimal and parseable.";
  }
  return "Apply the smallest targeted correction that directly resolves the failure.";
}

function buildConstraint(
  message: string,
  reason: NormalizedFailureReason,
  repeatedFailure: boolean
): string {
  const repeatPrefix = repeatedFailure
    ? "Use a different correction strategy than the previous attempt. "
    : "";

  if (/locked[_ -]?out/i.test(message) && /invalid credentials|invalid username|invalid password/i.test(message)) {
    return `${repeatPrefix}Do not assume this username is locked out unless the target app actually supports it; align the expectation with the observed invalid-credentials behavior.`;
  }

  if (reason === "assertion_mismatch") {
    return `${repeatPrefix}Correct the expectation instead of duplicating it; prefer the real application behavior shown in the assertion output.`;
  }

  if (reason === "unsupported_behavior_assumption") {
    return `${repeatPrefix}Use repo-supported behavior only; do not invent selectors, API responses, fixtures, files, or app states.`;
  }

  if (reason === "verification_timeout") {
    return `${repeatPrefix}Avoid waiting for behavior that is not proven by the app; use existing routes, selectors, and stable readiness signals.`;
  }

  if (reason === "missing_dependency") {
    return `${repeatPrefix}Use only modules and paths that exist in the repository context.`;
  }

  if (reason === "type_error") {
    return `${repeatPrefix}Do not force types with casts unless necessary; align with existing type definitions.`;
  }

  if (reason === "lint_error") {
    return `${repeatPrefix}Do not make broad formatting or behavior edits; fix only the reported static-analysis violation.`;
  }

  if (reason === "runtime_error") {
    return `${repeatPrefix}Do not mask the runtime error; correct the failing code path directly.`;
  }

  if (reason === "wrong_repo_assumption") {
    return `${repeatPrefix}Do not reference files, scripts, paths, or dependencies unless they exist in the repo context.`;
  }

  return `${repeatPrefix}Do not repeat the same assumption; make the next attempt address the concrete failure text.`;
}

function buildScopeConstraint(reason: NormalizedFailureReason): string {
  if (reason === "assertion_mismatch") {
    return "Keep scope to the failing assertion, fixture, or directly related behavior.";
  }
  if (reason === "syntax_error" || reason === "type_error" || reason === "lint_error") {
    return "Keep scope to the file and lines implicated by the compiler/linter output.";
  }
  if (reason === "missing_dependency" || reason === "wrong_repo_assumption") {
    return "Keep scope to correcting the invalid repo reference; do not restructure the project.";
  }
  if (reason === "runtime_error") {
    return "Keep scope to the failing runtime path and its immediate dependencies.";
  }
  return "Keep scope local to the failed verification target unless the task explicitly requires broader edits.";
}

function buildFailureSignature(input: {
  failedTarget: string;
  reason: string;
  expected: string;
  actual: string;
  message: string;
}): string {
  const basis = [
    input.failedTarget,
    input.reason,
    input.expected,
    input.actual,
    input.message.slice(0, 500),
  ]
    .map((part) => normalizeWhitespace(part.toLowerCase()))
    .filter(Boolean)
    .join("|");
  return basis || "unknown_failure";
}

export function analyzeFailure(input: {
  issues: Array<{ code: string; message: string }>;
}): FailureAnalysis & {
  failedTarget: string;
  normalizedFailureReason: NormalizedFailureReason;
  failureSignature: string;
} {
  const message = input.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n");
  const failedTarget =
    firstMatch(message, [
      /((?:[\w.-]+[\\/])*[\w.-]+\.(?:spec|test|cy)\.[jt]sx?)/i,
      /((?:[\w.-]+[\\/])*[\w.-]+\.(?:feature|java|py|ts|tsx|js|jsx))/i,
      /((?:[\w.-]+[\\/])*[\w.-]+\.(?:json|yml|yaml|css|scss|md))/i,
      /File\s+["']([^"']+)["'],\s+line\s+\d+/i,
      /\bat\s+((?:[\w.-]+[\\/])*[\w.-]+\.[jt]sx?:\d+:\d+)/i,
      /((?:[\w.-]+[\\/])*[\w.-]+\.[jt]sx?)\(\d+,\d+\):\s+error\s+TS\d+/i,
      />\s*([^\n]+)$/m,
    ]) || "unknown target";
  const normalizedFailureReason = normalizeReason(message);
  const expected = extractExpected(message);
  const actual = extractActual(message);
  const rootCause = buildRootCause(normalizedFailureReason, expected, actual);
  const incorrectAssumption = extractIncorrectAssumption(
    message,
    normalizedFailureReason,
    expected,
    actual
  );
  const realBehavior = buildRealBehavior(actual, normalizedFailureReason);
  const fixStrategy = buildFixStrategy(normalizedFailureReason);
  const failureSignature = buildFailureSignature({
    failedTarget,
    reason: normalizedFailureReason,
    expected,
    actual,
    message,
  });

  return {
    failedTarget,
    normalizedFailureReason,
    failureType: normalizedFailureReason,
    failureSignature,
    expected,
    actual,
    rootCause,
    incorrectAssumption,
    realBehavior,
    fixStrategy,
  };
}

export function buildRetryGuidanceFromFailure(input: {
  issues: Array<{ code: string; message: string }>;
  repeatedFailureCount?: number;
}): RetryGuidanceBrief {
  const message = input.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n");
  const analysis = analyzeFailure({ issues: input.issues });
  const repeatedFailure = (input.repeatedFailureCount ?? 0) > 0;
  const strictness =
    (input.repeatedFailureCount ?? 0) >= 2
      ? "escalated"
      : repeatedFailure
        ? "strict"
        : "normal";
  const requiredFix = buildRequiredFix(
    analysis.normalizedFailureReason,
    analysis.expected,
    analysis.actual
  );
  const constraint = buildConstraint(message, analysis.normalizedFailureReason, repeatedFailure);
  const escalation =
    strictness === "escalated"
      ? " The same failure repeated multiple times; change strategy now and do not make another cosmetic retry."
      : strictness === "strict"
        ? " The same failure repeated; the next attempt must use a different strategy."
        : "";

  return {
    failedTarget: analysis.failedTarget,
    normalizedFailureReason: analysis.normalizedFailureReason,
    rootCause: analysis.rootCause,
    expected: analysis.expected,
    actual: analysis.actual,
    incorrectAssumption: analysis.incorrectAssumption,
    realBehavior: analysis.realBehavior,
    requiredFix,
    fixStrategy: analysis.fixStrategy,
    constraint,
    nextAttemptConstraint: `${constraint}${escalation}`,
    minimalPatchDiscipline:
      "Prefer the smallest targeted patch. For tests, fix assertions/fixtures before adding new product logic unless the task explicitly requires product behavior changes.",
    scopeConstraint: buildScopeConstraint(analysis.normalizedFailureReason),
    failureSignature: analysis.failureSignature,
    repeatedFailure,
    strictness,
  };
}

export function formatRetryGuidanceBrief(brief: RetryGuidanceBrief): string {
  return [
    `- failed target/file/test: ${brief.failedTarget}`,
    `- normalized failure reason: ${brief.normalizedFailureReason}`,
    `- root cause: ${brief.rootCause}`,
    brief.expected ? `- expected: ${brief.expected}` : "",
    brief.actual ? `- actual / real behavior: ${brief.actual}` : `- real behavior: ${brief.realBehavior}`,
    `- incorrect assumption: ${brief.incorrectAssumption}`,
    `- required fix: ${brief.requiredFix}`,
    `- fix strategy: ${brief.fixStrategy}`,
    `- constraint: ${brief.constraint}`,
    `- scope to keep: ${brief.scopeConstraint}`,
    `- minimal patch discipline: ${brief.minimalPatchDiscipline}`,
    `- retry strictness: ${brief.strictness}`,
  ]
    .filter(Boolean)
    .join("\n");
}
