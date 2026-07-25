import { describe, expect, it } from "vitest";
import { convertParams } from "./convertParams.js";
import { getMaxOutputTokens } from "../models.js";

describe("max_tokens resolution in convertParams", () => {
  it("max_completion_tokens only → params.max_tokens equals that value (classifier path)", () => {
    const { params } = convertParams({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "classify this" }],
      max_completion_tokens: 300,
    });
    expect(params.max_tokens).toBe(300);
  });

  it("both max_tokens and max_completion_tokens → max_tokens wins", () => {
    const { params } = convertParams({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "classify this" }],
      max_tokens: 500,
      max_completion_tokens: 300,
    });
    expect(params.max_tokens).toBe(500);
  });

  it("neither field → the model's catalog output ceiling, not a fixed 4096", () => {
    const { params } = convertParams({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "classify this" }],
    });
    // Dated snapshot IDs resolve through the same longest-prefix match as the alias.
    expect(params.max_tokens).toBe(getMaxOutputTokens("claude-haiku-4-5"));
    expect(params.max_tokens).toBe(64_000);
  });

  it("unlisted model → conservative default, and an explicit budget passes through unclamped", () => {
    const { params: defaulted } = convertParams({
      model: "some-unlisted-model-v9",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(defaulted.max_tokens).toBe(16_384);

    const { params: explicit } = convertParams({
      model: "some-unlisted-model-v9",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 40_000,
    });
    expect(explicit.max_tokens).toBe(40_000);
  });

  it("an over-large request is clamped to the model's declared ceiling (never 400s)", () => {
    const { params } = convertParams({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 999_999,
    });
    expect(params.max_tokens).toBe(64_000);
  });

  it("adaptive model with NO effort configured still gets a thinking floor", () => {
    // claude-sonnet-5 thinks regardless of whether Zone sends output_config.effort;
    // thinking is spent inside max_tokens, so a 4096-ish budget truncated the answer.
    const { params } = convertParams({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1_000,
    });
    expect(params.max_tokens).toBe(16_384);
  });

  it("adaptive model with effort=max floors at the max-effort headroom", () => {
    const { params } = convertParams(
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1_000,
      },
      { effort: "max" }
    );
    expect(params.max_tokens).toBe(64_000);
  });

  it("non-thinking model gets no floor — small explicit budgets are honored", () => {
    const { params } = convertParams({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 300,
    });
    expect(params.max_tokens).toBe(300);
  });
});
