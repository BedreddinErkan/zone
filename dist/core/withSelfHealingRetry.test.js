"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const withSelfHealingRetry_js_1 = require("./withSelfHealingRetry.js");
(0, vitest_1.describe)("withSelfHealingRetry", () => {
    (0, vitest_1.it)("returns ok: true on first attempt when no errors", async () => {
        const execute = vitest_1.vi.fn().mockResolvedValue("valid");
        const validate = vitest_1.vi.fn().mockReturnValue([]);
        const result = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            prompt: "original prompt",
            execute,
            validate,
            buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
        });
        (0, vitest_1.expect)(result).toEqual({ ok: true, value: "valid", attempts: 1 });
        (0, vitest_1.expect)(execute).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("returns ok: true on second attempt after one error", async () => {
        const execute = vitest_1.vi
            .fn()
            .mockResolvedValueOnce("bad")
            .mockResolvedValueOnce("good");
        const validate = vitest_1.vi
            .fn()
            .mockReturnValueOnce([
            { code: "BAD_OUTPUT", message: "First result invalid", severity: "error" },
        ])
            .mockReturnValueOnce([]);
        const result = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            prompt: "original prompt",
            execute,
            validate,
            buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
        });
        (0, vitest_1.expect)(result).toEqual({ ok: true, value: "good", attempts: 2 });
        (0, vitest_1.expect)(execute).toHaveBeenNthCalledWith(1, "original prompt");
        (0, vitest_1.expect)(execute.mock.calls[1]?.[0]).toContain("SELF-HEALING FEEDBACK");
    });
    (0, vitest_1.it)("returns ok: false after maxAttempts exhausted", async () => {
        const execute = vitest_1.vi.fn().mockResolvedValue("bad");
        const issues = [
            { code: "BAD_OUTPUT", message: "Still invalid", severity: "error" },
        ];
        const validate = vitest_1.vi.fn().mockReturnValue(issues);
        const result = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            prompt: "original prompt",
            maxAttempts: 2,
            execute,
            validate,
            buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
        });
        (0, vitest_1.expect)(result).toEqual({
            ok: false,
            reason: "Validation failed after 2 attempts.",
            attempts: 2,
            lastIssues: issues,
        });
    });
    (0, vitest_1.it)("warnings alone do not trigger retry", async () => {
        const execute = vitest_1.vi.fn().mockResolvedValue("warning-only");
        const validate = vitest_1.vi.fn().mockReturnValue([
            { code: "STYLE", message: "Minor warning", severity: "warning" },
        ]);
        const result = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            prompt: "original prompt",
            execute,
            validate,
            buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
        });
        (0, vitest_1.expect)(result).toEqual({ ok: true, value: "warning-only", attempts: 1 });
        (0, vitest_1.expect)(execute).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("execute() error is treated as blocking issue", async () => {
        const execute = vitest_1.vi.fn().mockRejectedValueOnce(new Error("network down"));
        const result = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            prompt: "original prompt",
            maxAttempts: 1,
            execute,
            validate: () => [],
            buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
        });
        (0, vitest_1.expect)(result).toEqual({
            ok: false,
            reason: "Execution failed after 1 attempts.",
            attempts: 1,
            lastIssues: [
                {
                    code: "EXECUTE_ERROR",
                    message: "network down",
                    severity: "error",
                },
            ],
        });
    });
    (0, vitest_1.it)("attempt count is accurate in RetryResult", async () => {
        const execute = vitest_1.vi
            .fn()
            .mockResolvedValueOnce("bad")
            .mockResolvedValueOnce("bad-again")
            .mockResolvedValueOnce("good");
        const validate = vitest_1.vi
            .fn()
            .mockReturnValueOnce([
            { code: "ERR_1", message: "first", severity: "error" },
        ])
            .mockReturnValueOnce([
            { code: "ERR_2", message: "second", severity: "error" },
        ])
            .mockReturnValueOnce([]);
        const result = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            prompt: "original prompt",
            execute,
            validate,
            buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
        });
        (0, vitest_1.expect)(result).toEqual({ ok: true, value: "good", attempts: 3 });
    });
    (0, vitest_1.it)("buildDefaultFeedbackPrompt output contains issue codes and attempt number", () => {
        const prompt = (0, withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt)({
            attempt: 2,
            originalPrompt: "original prompt",
            issues: [
                { code: "ERR_A", message: "first issue", severity: "error" },
                { code: "ERR_B", message: "second issue", severity: "warning" },
            ],
        });
        (0, vitest_1.expect)(prompt).toContain("attempt 2");
        (0, vitest_1.expect)(prompt).toContain("[ERR_A] first issue");
        (0, vitest_1.expect)(prompt).toContain("[ERR_B] second issue");
    });
    (0, vitest_1.it)("maxAttempts is clamped to 1 minimum and 5 maximum", async () => {
        const executeMin = vitest_1.vi.fn().mockResolvedValue("bad");
        const validateMin = vitest_1.vi.fn().mockReturnValue([
            { code: "ERR_MIN", message: "min", severity: "error" },
        ]);
        const minResult = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            prompt: "original prompt",
            maxAttempts: 0,
            execute: executeMin,
            validate: validateMin,
            buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
        });
        (0, vitest_1.expect)(minResult).toEqual({
            ok: false,
            reason: "Validation failed after 1 attempts.",
            attempts: 1,
            lastIssues: [{ code: "ERR_MIN", message: "min", severity: "error" }],
        });
        (0, vitest_1.expect)(executeMin).toHaveBeenCalledTimes(1);
        const executeMax = vitest_1.vi.fn().mockResolvedValue("bad");
        const validateMax = vitest_1.vi.fn().mockReturnValue([
            { code: "ERR_MAX", message: "max", severity: "error" },
        ]);
        const maxResult = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
            prompt: "original prompt",
            maxAttempts: 99,
            execute: executeMax,
            validate: validateMax,
            buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
        });
        (0, vitest_1.expect)(maxResult).toEqual({
            ok: false,
            reason: "Validation failed after 5 attempts.",
            attempts: 5,
            lastIssues: [{ code: "ERR_MAX", message: "max", severity: "error" }],
        });
        (0, vitest_1.expect)(executeMax).toHaveBeenCalledTimes(5);
    });
});
//# sourceMappingURL=withSelfHealingRetry.test.js.map