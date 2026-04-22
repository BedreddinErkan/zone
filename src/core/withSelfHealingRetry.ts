import {
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

export function buildDefaultFeedbackPrompt(feedback: RetryFeedback): string {
  const issueLines = feedback.issues
    .map((issue) => `- [${issue.code}] ${issue.message}`)
    .join("\n");
  const retryGuidance = buildRetryGuidanceFromFailure({
    issues: feedback.issues,
  });

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
    "Please fix ALL of the above issues and return a corrected output.",
    "Do NOT repeat the same mistakes.",
    retryGuidance.nextAttemptConstraint,
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await options.execute(currentPrompt);
      const issues = options.validate(value);

      if (!hasBlockingIssues(issues)) {
        return { ok: true, value, attempts: attempt };
      }

      lastIssues = issues;
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
      });
    } catch (error) {
      const issues = normalizeExecuteError(error);
      lastIssues = issues;

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
