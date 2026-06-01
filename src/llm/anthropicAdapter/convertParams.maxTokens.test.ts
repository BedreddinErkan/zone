import { describe, expect, it } from "vitest";
import { convertParams } from "./convertParams.js";

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

  it("neither field → defaults to 4096", () => {
    const { params } = convertParams({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "classify this" }],
    });
    expect(params.max_tokens).toBe(4096);
  });
});
