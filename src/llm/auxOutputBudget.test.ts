/**
 * Auxiliary one-shot calls must ask for a bounded output budget.
 *
 * Passing no max_tokens makes convertParams inject the model's ceiling — up to 128k
 * — onto a single held non-streaming connection, for calls that produce a few
 * thousand tokens of JSON. The bound is anchored to a recorded failure, not to an
 * estimate of typical size: when this defaulted to 4096, a real plan-gen call on
 * claude-sonnet-5 returned stop_reason "max_tokens" with JSON that threw
 * `Unterminated string in JSON at position 5338`.
 */
import { describe, it, expect } from "vitest";
import { convertParams } from "./anthropicAdapter/convertParams.js";
import { AUX_CALL_MAX_OUTPUT_TOKENS, getMaxOutputTokens } from "./models.js";

/** The payload size that actually failed, in characters. */
const RECORDED_TRUNCATION_CHARS = 5_338;

/** convertParams' own heuristic, used here for the same reason it uses it. */
const CHARS_PER_TOKEN = 4;

describe("AUX_CALL_MAX_OUTPUT_TOKENS is defended by the failure that motivated it", () => {
  it("clears a plan payload at least as large as the one that truncated", () => {
    // Reconstruct a plan-shaped body no smaller than the recorded failure, rather
    // than asserting against a guess at "typical" size.
    const step = `{"description":"${"x".repeat(200)}","filesLikely":["src/a.ts","src/b.ts"]},`;
    const planJson = `{"objective":"${"y".repeat(300)}","steps":[${step.repeat(30)}],"riskHints":[]}`;
    expect(planJson.length).toBeGreaterThanOrEqual(RECORDED_TRUNCATION_CHARS);

    const neededTokens = Math.ceil(planJson.length / CHARS_PER_TOKEN);
    expect(AUX_CALL_MAX_OUTPUT_TOKENS).toBeGreaterThan(neededTokens);
  });

  it("is comfortably above the 4096 budget that demonstrably failed", () => {
    expect(AUX_CALL_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4_096 * 4);
  });

  it("is well below the model ceiling it replaces", () => {
    // The whole point: a bounded artifact should not reserve a frontier model's
    // entire output budget on a non-streaming connection.
    expect(AUX_CALL_MAX_OUTPUT_TOKENS).toBeLessThan(getMaxOutputTokens("claude-sonnet-5"));
    expect(AUX_CALL_MAX_OUTPUT_TOKENS).toBeLessThan(getMaxOutputTokens("claude-sonnet-4-6"));
  });
});

describe("the bound is a ceiling, not a floor", () => {
  const request = (extra: Record<string, unknown>) => ({
    model: "claude-opus-4-8",
    messages: [{ role: "user" as const, content: "hi" }],
    ...extra,
  });

  it("a high-effort thinking model still floors upward past it", () => {
    // convertParams applies Math.max(budget, effortFloor), so bounding the auxiliary
    // budget must not starve thinking — the failure the previous increment fixed.
    const { params } = convertParams(
      request({ max_tokens: AUX_CALL_MAX_OUTPUT_TOKENS }),
      { effort: "max" }
    );
    expect(params.max_tokens).toBeGreaterThan(AUX_CALL_MAX_OUTPUT_TOKENS);
  });

  it("at default effort the bound is what gets sent", () => {
    const { params } = convertParams(request({ max_tokens: AUX_CALL_MAX_OUTPUT_TOKENS }));
    expect(params.max_tokens).toBe(AUX_CALL_MAX_OUTPUT_TOKENS);
  });

  it("without a budget the model ceiling is injected — the behaviour being bounded", () => {
    const { params } = convertParams(request({}));
    expect(params.max_tokens).toBe(getMaxOutputTokens("claude-opus-4-8"));
    expect(params.max_tokens).toBeGreaterThan(AUX_CALL_MAX_OUTPUT_TOKENS);
  });
});
