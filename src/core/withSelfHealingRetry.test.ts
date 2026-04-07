import { describe, expect, it, vi } from "vitest";
import {
  buildDefaultFeedbackPrompt,
  withSelfHealingRetry,
} from "./withSelfHealingRetry.js";

describe("withSelfHealingRetry", () => {
  it("returns ok: true on first attempt when no errors", async () => {
    const execute = vi.fn().mockResolvedValue("valid");
    const validate = vi.fn().mockReturnValue([]);

    const result = await withSelfHealingRetry({
      prompt: "original prompt",
      execute,
      validate,
      buildFeedbackPrompt: buildDefaultFeedbackPrompt,
    });

    expect(result).toEqual({ ok: true, value: "valid", attempts: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns ok: true on second attempt after one error", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce("bad")
      .mockResolvedValueOnce("good");
    const validate = vi
      .fn()
      .mockReturnValueOnce([
        { code: "BAD_OUTPUT", message: "First result invalid", severity: "error" },
      ])
      .mockReturnValueOnce([]);

    const result = await withSelfHealingRetry({
      prompt: "original prompt",
      execute,
      validate,
      buildFeedbackPrompt: buildDefaultFeedbackPrompt,
    });

    expect(result).toEqual({ ok: true, value: "good", attempts: 2 });
    expect(execute).toHaveBeenNthCalledWith(1, "original prompt");
    expect(execute.mock.calls[1]?.[0]).toContain("SELF-HEALING FEEDBACK");
  });

  it("returns ok: false after maxAttempts exhausted", async () => {
    const execute = vi.fn().mockResolvedValue("bad");
    const issues = [
      { code: "BAD_OUTPUT", message: "Still invalid", severity: "error" as const },
    ];
    const validate = vi.fn().mockReturnValue(issues);

    const result = await withSelfHealingRetry({
      prompt: "original prompt",
      maxAttempts: 2,
      execute,
      validate,
      buildFeedbackPrompt: buildDefaultFeedbackPrompt,
    });

    expect(result).toEqual({
      ok: false,
      reason: "Validation failed after 2 attempts.",
      attempts: 2,
      lastIssues: issues,
    });
  });

  it("warnings alone do not trigger retry", async () => {
    const execute = vi.fn().mockResolvedValue("warning-only");
    const validate = vi.fn().mockReturnValue([
      { code: "STYLE", message: "Minor warning", severity: "warning" },
    ]);

    const result = await withSelfHealingRetry({
      prompt: "original prompt",
      execute,
      validate,
      buildFeedbackPrompt: buildDefaultFeedbackPrompt,
    });

    expect(result).toEqual({ ok: true, value: "warning-only", attempts: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("execute() error is treated as blocking issue", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("network down"));

    const result = await withSelfHealingRetry({
      prompt: "original prompt",
      maxAttempts: 1,
      execute,
      validate: () => [],
      buildFeedbackPrompt: buildDefaultFeedbackPrompt,
    });

    expect(result).toEqual({
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

  it("attempt count is accurate in RetryResult", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce("bad")
      .mockResolvedValueOnce("bad-again")
      .mockResolvedValueOnce("good");
    const validate = vi
      .fn()
      .mockReturnValueOnce([
        { code: "ERR_1", message: "first", severity: "error" },
      ])
      .mockReturnValueOnce([
        { code: "ERR_2", message: "second", severity: "error" },
      ])
      .mockReturnValueOnce([]);

    const result = await withSelfHealingRetry({
      prompt: "original prompt",
      execute,
      validate,
      buildFeedbackPrompt: buildDefaultFeedbackPrompt,
    });

    expect(result).toEqual({ ok: true, value: "good", attempts: 3 });
  });

  it("buildDefaultFeedbackPrompt output contains issue codes and attempt number", () => {
    const prompt = buildDefaultFeedbackPrompt({
      attempt: 2,
      originalPrompt: "original prompt",
      issues: [
        { code: "ERR_A", message: "first issue", severity: "error" },
        { code: "ERR_B", message: "second issue", severity: "warning" },
      ],
    });

    expect(prompt).toContain("attempt 2");
    expect(prompt).toContain("[ERR_A] first issue");
    expect(prompt).toContain("[ERR_B] second issue");
  });

  it("maxAttempts is clamped to 1 minimum and 5 maximum", async () => {
    const executeMin = vi.fn().mockResolvedValue("bad");
    const validateMin = vi.fn().mockReturnValue([
      { code: "ERR_MIN", message: "min", severity: "error" },
    ]);

    const minResult = await withSelfHealingRetry({
      prompt: "original prompt",
      maxAttempts: 0,
      execute: executeMin,
      validate: validateMin,
      buildFeedbackPrompt: buildDefaultFeedbackPrompt,
    });

    expect(minResult).toEqual({
      ok: false,
      reason: "Validation failed after 1 attempts.",
      attempts: 1,
      lastIssues: [{ code: "ERR_MIN", message: "min", severity: "error" }],
    });
    expect(executeMin).toHaveBeenCalledTimes(1);

    const executeMax = vi.fn().mockResolvedValue("bad");
    const validateMax = vi.fn().mockReturnValue([
      { code: "ERR_MAX", message: "max", severity: "error" },
    ]);

    const maxResult = await withSelfHealingRetry({
      prompt: "original prompt",
      maxAttempts: 99,
      execute: executeMax,
      validate: validateMax,
      buildFeedbackPrompt: buildDefaultFeedbackPrompt,
    });

    expect(maxResult).toEqual({
      ok: false,
      reason: "Validation failed after 5 attempts.",
      attempts: 5,
      lastIssues: [{ code: "ERR_MAX", message: "max", severity: "error" }],
    });
    expect(executeMax).toHaveBeenCalledTimes(5);
  });
});
