"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRetryGuidanceFromFailure = buildRetryGuidanceFromFailure;
exports.formatRetryGuidanceBrief = formatRetryGuidanceBrief;
function firstMatch(value, patterns) {
    for (const pattern of patterns) {
        const match = value.match(pattern);
        const candidate = match?.[1]?.trim();
        if (candidate)
            return candidate.slice(0, 240);
    }
    return "";
}
function normalizeReason(message) {
    const normalized = message.toLowerCase();
    if (normalized.includes("expected") || normalized.includes("received") || normalized.includes("tohave") || normalized.includes("tocontain")) {
        return "assertion_mismatch";
    }
    if (normalized.includes("timeout") || normalized.includes("timed out")) {
        return "timeout";
    }
    if (normalized.includes("locator") || normalized.includes("selector")) {
        return "selector_mismatch";
    }
    if (normalized.includes("cannot find module") || normalized.includes("module not found")) {
        return "missing_import";
    }
    if (normalized.includes("syntaxerror") || normalized.includes("unexpected token")) {
        return "syntax_error";
    }
    return "verification_failure";
}
function extractIncorrectAssumption(message) {
    const expected = firstMatch(message, [
        /Expected(?:\s+string)?:\s*["'`]?([^"'`\n]+)["'`]?/i,
        /expected(?:\s+[^"'`\n]+)?\s+["'`]([^"'`\n]+)["'`]/i,
        /toContainText\(\s*["'`]([^"'`]+)["'`]\s*\)/i,
        /toHaveText\(\s*["'`]([^"'`]+)["'`]\s*\)/i,
    ]);
    const received = firstMatch(message, [
        /Received(?:\s+string)?:\s*["'`]?([^"'`\n]+)["'`]?/i,
        /but got\s+["'`]([^"'`\n]+)["'`]/i,
        /actual(?:\s+[^"'`\n]+)?\s+["'`]([^"'`\n]+)["'`]/i,
    ]);
    if (expected && received) {
        return `Expected "${expected}", but observed "${received}".`;
    }
    if (/locked[_ -]?out/i.test(message) && /invalid credentials|invalid username|invalid password/i.test(message)) {
        return "The previous attempt assumed the user was locked out, but the app reported invalid credentials.";
    }
    if (expected) {
        return `The previous attempt introduced or kept an expectation for "${expected}" without confirming the app behavior.`;
    }
    return "The previous attempt introduced a failing expectation or unsupported implementation detail.";
}
function buildConstraint(message, reason) {
    if (/locked[_ -]?out/i.test(message) && /invalid credentials|invalid username|invalid password/i.test(message)) {
        return "Do not assume this username is locked out unless the target app actually supports it; align the expectation with the observed invalid-credentials behavior.";
    }
    if (reason === "assertion_mismatch") {
        return "Correct the expectation instead of duplicating it; prefer the real application behavior shown in the assertion output.";
    }
    if (reason === "selector_mismatch") {
        return "Use selectors that exist in the provided app/test context; do not invent selectors.";
    }
    if (reason === "timeout") {
        return "Avoid waiting for behavior that is not proven by the app; use existing routes, selectors, and stable readiness signals.";
    }
    if (reason === "missing_import") {
        return "Use only modules and paths that exist in the repository context.";
    }
    return "Do not repeat the same assumption; make the next attempt address the concrete failure text.";
}
function buildRetryGuidanceFromFailure(input) {
    const message = input.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n");
    const failedTarget = firstMatch(message, [
        /((?:[\w.-]+[\\/])*[\w.-]+\.(?:spec|test|cy)\.[jt]sx?)/i,
        /((?:[\w.-]+[\\/])*[\w.-]+\.(?:feature|java|py|ts|tsx|js|jsx))/i,
        /›\s*([^\n]+)$/m,
    ]) || "unknown target";
    const normalizedFailureReason = normalizeReason(message);
    const incorrectAssumption = extractIncorrectAssumption(message);
    const nextAttemptConstraint = buildConstraint(message, normalizedFailureReason);
    return {
        failedTarget,
        normalizedFailureReason,
        incorrectAssumption,
        nextAttemptConstraint,
    };
}
function formatRetryGuidanceBrief(brief) {
    return [
        `- failed target/file/test: ${brief.failedTarget}`,
        `- normalized failure reason: ${brief.normalizedFailureReason}`,
        `- incorrect assumption: ${brief.incorrectAssumption}`,
        `- next-attempt constraint: ${brief.nextAttemptConstraint}`,
    ].join("\n");
}
//# sourceMappingURL=buildRetryGuidanceFromFailure.js.map