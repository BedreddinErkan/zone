import { describe, it, expect } from "vitest";
import { convertParams } from "./convertParams.js";

describe("convertParams — effort/thinking injection", () => {
  it("effort=high on claude-sonnet-4-6 injects thinking block with correct constraints", () => {
    const { params } = convertParams(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.7,
        stop: ["DONE"],
      },
      { effort: "high" }
    );

    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 32000 });
    expect(params.temperature).toBeUndefined();
    expect((params as Record<string, unknown>).stop_sequences).toBeUndefined();
    expect(params.max_tokens).toBeGreaterThanOrEqual(32000 + 2048);
  });

  it("effort=medium on claude-haiku-4-5 is a silent no-op", () => {
    const { params } = convertParams(
      {
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.5,
        stop: ["END"],
      },
      { effort: "medium" }
    );

    expect(params.thinking).toBeUndefined();
    expect(params.temperature).toBe(0.5);
    expect((params as Record<string, unknown>).stop_sequences).toEqual(["END"]);
  });
});
