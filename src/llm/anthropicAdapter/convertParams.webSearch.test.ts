import { describe, it, expect } from "vitest";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { convertParams } from "./convertParams.js";

const dummyTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "dummy",
    description: "A test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

// Long enough to pass CACHE_MIN_CHARS (8200) alone, making the request cache-eligible.
const longSystem = "x".repeat(9000);

describe("convertParams — webSearch", () => {
  it("appends web_search entry when webSearch=true", () => {
    const { params } = convertParams(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools: [dummyTool],
      },
      { webSearch: true },
    );
    expect(params.tools).toHaveLength(2);
    const wsEntry = params.tools?.[1] as Record<string, unknown>;
    expect(wsEntry).toMatchObject({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
  });

  it("web_search entry has no cache_control; preceding function tool has cache_control when eligible", () => {
    const { params } = convertParams(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "system", content: longSystem }, { role: "user", content: "hi" }],
        tools: [dummyTool],
      },
      { webSearch: true },
    );
    const tools = params.tools!;
    expect(tools).toHaveLength(2);
    // Function tool gets cache_control (last function tool before web_search append)
    expect((tools[0] as Record<string, unknown>).cache_control).toBeDefined();
    // web_search entry must NOT have cache_control
    expect((tools[1] as Record<string, unknown>).cache_control).toBeUndefined();
  });

  it("does not append when webSearch=false", () => {
    const { params } = convertParams(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools: [dummyTool],
      },
      { webSearch: false },
    );
    expect(params.tools).toHaveLength(1);
  });

  it("does not append when webSearch is omitted", () => {
    const { params } = convertParams({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [dummyTool],
    });
    expect(params.tools).toHaveLength(1);
  });

  it("creates a tools array with only web_search when no function tools provided", () => {
    const { params } = convertParams(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      },
      { webSearch: true },
    );
    expect(params.tools).toHaveLength(1);
    expect(params.tools?.[0]).toMatchObject({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
    });
  });

  it("produces identical tool order on repeated calls (determinism)", () => {
    const input = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user" as const, content: "hi" }],
      tools: [dummyTool],
    };
    const { params: p1 } = convertParams(input, { webSearch: true });
    const { params: p2 } = convertParams(input, { webSearch: true });
    expect(p1.tools).toEqual(p2.tools);
  });
});
