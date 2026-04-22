import {
  analyzeFailure,
  buildRetryGuidanceFromFailure,
  formatRetryGuidanceBrief,
} from "./buildRetryGuidanceFromFailure.js";

export type RetryFeedback = {
  attempt: number;
  issues: Array<{
    code: string;
    message: string;
    severity: "warning" | "error";
  }>;
  originalPrompt: string;
  failureSignature?: string;
  repeatedFailureCount?: number;
};

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | {
      ok: false;
      reason: string;
      attempts: number;
      lastIssues: RetryFeedback["issues"];
    };

type RetryIssue = RetryFeedback["issues"][number];

function clampAttempts(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.round(value as number)));
}

function normalizeExecuteError(error: unknown): RetryIssue[] {
  return [
    {
      code: "EXECUTE_ERROR",
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
    },
  ];
}

function hasBlockingIssues(issues: RetryIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

function buildIssueSignature(issues: RetryIssue[]): string {
  const analysis = analyzeFailure({ issues });
  const fallback = issues
    .map((issue) => `${issue.code}:${issue.message}`)
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 500);
  return [
    analysis.failedTarget,
    analysis.normalizedFailureReason,
    analysis.expected,
    analysis.actual,
    analysis.incorrectAssumption,
    analysis.failedTarget === "unknown target" && !analysis.expected && !analysis.actual
      ? fallback
      : "",
  ]
    .filter(Boolean)
    .join("|");
}

export function buildDefaultFeedbackPrompt(feedback: RetryFeedback): string {
  const issueLines = feedback.issues
    .map((issue) => `- [${issue.code}] ${issue.message}`)
    .join("\n");
  const retryGuidance = buildRetryGuidanceFromFailure({
    issues: feedback.issues,
    repeatedFailureCount: feedback.repeatedFailureCount,
  });
  const repeated = (feedback.repeatedFailureCount ?? 0) > 0;

  return [
    feedback.originalPrompt,
    "",
    "=== SELF-HEALING FEEDBACK (attempt " + feedback.attempt + ") ===",
    "The previous output was rejected due to the following issues:",
    issueLines,
    "",
    "STRUCTURED RETRY BRIEF:",
    formatRetryGuidanceBrief(retryGuidance),
    "",
    "ROOT CAUSE:",
    retryGuidance.rootCause,
    "",
    "WHAT WAS WRONG:",
    retryGuidance.incorrectAssumption,
    "",
    "WHAT MUST CHANGE:",
    retryGuidance.requiredFix,
    "",
    "WHAT MUST NOT BE REPEATED:",
    retryGuidance.nextAttemptConstraint,
    "",
    "WHAT SCOPE TO KEEP:",
    retryGuidance.scopeConstraint,
    "",
    "NO-CHANGE GUARD:",
    "Verification failed, so do not return 'no changes needed' or an unchanged patch unless you can prove the repo already matches the requested correct state. Produce a concrete correction.",
    "",
    ...(repeated
      ? [
          "RETRY ESCALATION:",
          "The same failure repeated. Use a different strategy, increase strictness, and do not duplicate the previous assumption.",
          "",
        ]
      : []),
    "MINIMAL PATCH DISCIPLINE:",
    retryGuidance.minimalPatchDiscipline,
    "",
    "Please fix ALL of the above issues and return a corrected output.",
    "=== END FEEDBACK ===",
  ].join("\n");
}

export async function withSelfHealingRetry<T>(options: {
  maxAttempts?: number;
  prompt: string;
  execute: (prompt: string) => Promise<T>;
  validate: (result: T) => Array<RetryIssue>;
  buildFeedbackPrompt: (feedback: RetryFeedback) => string;
}): Promise<RetryResult<T>> {
  const maxAttempts = clampAttempts(options.maxAttempts);
  const originalPrompt = options.prompt;
  let currentPrompt = originalPrompt;
  let lastIssues: RetryIssue[] = [];
  let previousFailureSignature = "";
  let repeatedFailureCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await options.execute(currentPrompt);
      const issues = options.validate(value);

      if (!hasBlockingIssues(issues)) {
        return { ok: true, value, attempts: attempt };
      }

      lastIssues = issues;
      const failureSignature = buildIssueSignature(issues);
      repeatedFailureCount =
        failureSignature && failureSignature === previousFailureSignature
          ? repeatedFailureCount + 1
          : 0;
      previousFailureSignature = failureSignature;
      if (attempt === maxAttempts) {
        return {
          ok: false,
          reason: `Validation failed after ${attempt} attempts.`,
          attempts: attempt,
          lastIssues,
        };
      }

      currentPrompt = options.buildFeedbackPrompt({
        attempt,
        issues,
        originalPrompt,
        failureSignature,
        repeatedFailureCount,
      });
    } catch (error) {
      const issues = normalizeExecuteError(error);
      lastIssues = issues;
      const failureSignature = buildIssueSignature(issues);
      repeatedFailureCount =
        failureSignature && failureSignature === previousFailureSignature
          ? repeatedFailureCount + 1
          : 0;
      previousFailureSignature = failureSignature;

      if (attempt === maxAttempts) {
        return {
          ok: false,
          reason: `Execution failed after ${attempt} attempts.`,
          attempts: attempt,
          lastIssues,
        };
      }

      currentPrompt = options.buildFeedbackPrompt({
        attempt,
        issues,
        originalPrompt,
        failureSignature,
        repeatedFailureCount,
      });
    }
  }

  return {
    ok: false,
    reason: `Validation failed after ${maxAttempts} attempts.`,
    attempts: maxAttempts,
    lastIssues,
  };
}
