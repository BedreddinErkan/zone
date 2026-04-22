"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDefaultFeedbackPrompt = buildDefaultFeedbackPrompt;
exports.withSelfHealingRetry = withSelfHealingRetry;
const buildRetryGuidanceFromFailure_js_1 = require("./buildRetryGuidanceFromFailure.js");
function clampAttempts(value) {
    if (!Number.isFinite(value))
        return 3;
    return Math.min(5, Math.max(1, Math.round(value)));
}
function normalizeExecuteError(error) {
    return [
        {
            code: "EXECUTE_ERROR",
            message: error instanceof Error ? error.message : String(error),
            severity: "error",
        },
    ];
}
function hasBlockingIssues(issues) {
    return issues.some((issue) => issue.severity === "error");
}
function buildDefaultFeedbackPrompt(feedback) {
    const issueLines = feedback.issues
        .map((issue) => `- [${issue.code}] ${issue.message}`)
        .join("\n");
    const retryGuidance = (0, buildRetryGuidanceFromFailure_js_1.buildRetryGuidanceFromFailure)({
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
        (0, buildRetryGuidanceFromFailure_js_1.formatRetryGuidanceBrief)(retryGuidance),
        "",
        "Please fix ALL of the above issues and return a corrected output.",
        "Do NOT repeat the same mistakes.",
        retryGuidance.nextAttemptConstraint,
        "=== END FEEDBACK ===",
    ].join("\n");
}
async function withSelfHealingRetry(options) {
    const maxAttempts = clampAttempts(options.maxAttempts);
    const originalPrompt = options.prompt;
    let currentPrompt = originalPrompt;
    let lastIssues = [];
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
        }
        catch (error) {
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
//# sourceMappingURL=withSelfHealingRetry.js.map