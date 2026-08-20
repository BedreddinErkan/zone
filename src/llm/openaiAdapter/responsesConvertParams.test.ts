import { describe, it, expect } from "vitest";
import { responsesConvertParams } from "./responsesConvertParams.js";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

function makeBase(
  messages: ChatCompletionCreateParamsNonStreaming["messages"],
  overrides: Partial<ChatCompletionCreateParamsNonStreaming> = {}
): ChatCompletionCreateParamsNonStreaming {
  return {
    model: "gpt-5.4",
    messages,
    tools: [],
    tool_choice: "auto",
    max_tokens: 16384,
    ...overrides,
  } as ChatCompletionCreateParamsNonStreaming;
}

describe("responsesConvertParams — fixed fields", () => {
  it("always emits store:false and include with reasoning.encrypted_content", () => {
    const result = responsesConvertParams(makeBase([{ role: "user", content: "hi" }]), {});
    expect(result.store).toBe(false);
    expect(result.include).toContain("reasoning.encrypted_content");
  });

  it("emits max_output_tokens from max_tokens; no max_tokens in output", () => {
    const result = responsesConvertParams(makeBase([{ role: "user", content: "hi" }]), {});
    expect(result.max_output_tokens).toBe(16384);
    expect((result as Record<string, unknown>).max_tokens).toBeUndefined();
  });
});

describe("responsesConvertParams — tool unnesting", () => {
  it("unnests ChatCompletionTool to flat FunctionTool", () => {
    const params = makeBase([{ role: "user", content: "hi" }], {
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Reads a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    });
    const result = responsesConvertParams(params, {});
    const tool = (result.tools as unknown[])?.[0] as Record<string, unknown>;
    expect(tool.type).toBe("function");
    expect(tool.name).toBe("read_file");
    expect(tool.description).toBe("Reads a file");
    expect((tool.parameters as Record<string, unknown>).type).toBe("object");
    // Must NOT have a nested `function` key
    expect(tool.function).toBeUndefined();
  });
});

describe("responsesConvertParams — effort → reasoning", () => {
  it("high effort → reasoning:{summary:'auto', effort:'high'}", () => {
    const result = responsesConvertParams(makeBase([{ role: "user", content: "hi" }]), { effort: "high" });
    expect(result.reasoning).toEqual({ summary: "auto", effort: "high" });
  });

  it("max effort clamps to high for gpt-5.4", () => {
    const result = responsesConvertParams(makeBase([{ role: "user", content: "hi" }]), { effort: "max" });
    expect(result.reasoning).toEqual({ summary: "auto", effort: "high" });
  });

  it("xhigh effort clamps to high for gpt-5.4", () => {
    const result = responsesConvertParams(makeBase([{ role: "user", content: "hi" }]), { effort: "xhigh" });
    expect(result.reasoning).toEqual({ summary: "auto", effort: "high" });
  });

  it("no effort → reasoning is still sent, with summary:'auto' and no effort key", () => {
    const result = responsesConvertParams(makeBase([{ role: "user", content: "hi" }]), {});
    expect(result.reasoning).toEqual({ summary: "auto" });
  });

  it("a model excluded from supportsEffort → no reasoning field at all, even with effort requested", () => {
    // Was gpt-5.4-nano until 2026-08-20. Live measurement corrected that exclusion — nano accepts
    // both reasoning parameters and returns real summary prose — so it is no longer an example of
    // this branch. An UNLISTED gpt-5* id is: it reaches the Responses converter (the routing gate
    // is a bare `startsWith("gpt-5")` on a string the OPENAI_MODEL / ZONE_LLM_MODEL_HIGH env vars
    // set without any catalog validation) while having no capability entry to authorise reasoning.
    const result = responsesConvertParams(
      makeBase([{ role: "user", content: "hi" }], { model: "gpt-5.9-unlisted" }),
      { effort: "high" }
    );
    expect(result.reasoning).toBeUndefined();
  });

  it("gpt-5.4-nano now gets a reasoning object, matching what the API actually accepts", () => {
    const result = responsesConvertParams(
      makeBase([{ role: "user", content: "hi" }], { model: "gpt-5.4-nano" }),
      { effort: "high" }
    );
    expect(result.reasoning).toEqual({ summary: "auto", effort: "high" });
  });

  it("a dated OpenAI id gets the same reasoning object as its base alias", () => {
    // The defect the shared normalizer closed: a dated id used to resolve to no capability entry,
    // so last pass's shipped summary:"auto" never reached anyone running one.
    const dated = responsesConvertParams(
      makeBase([{ role: "user", content: "hi" }], { model: "gpt-5.5-2026-04-23" }),
      { effort: "high" }
    );
    expect(dated.reasoning).toEqual({ summary: "auto", effort: "high" });
  });
});

describe("responsesConvertParams — tool_result → function_call_output", () => {
  it("translates role:tool to function_call_output", () => {
    const params = makeBase([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_abc", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_abc", content: "file contents" },
    ]);
    const result = responsesConvertParams(params, {});
    const fco = (result.input as unknown[]).find(
      (item) => (item as Record<string, unknown>).type === "function_call_output"
    ) as Record<string, unknown>;
    expect(fco).toBeDefined();
    expect(fco.call_id).toBe("call_abc");
    expect(fco.output).toBe("file contents");
  });
});

describe("responsesConvertParams — user image parts", () => {
  it("translates image_url content part to input_image", () => {
    const params = makeBase([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
        ],
      },
    ] as ChatCompletionCreateParamsNonStreaming["messages"]);
    const result = responsesConvertParams(params, {});
    const msgItem = (result.input as unknown[])[0] as Record<string, unknown>;
    const parts = msgItem.content as Record<string, unknown>[];
    expect(parts[0]).toEqual({ type: "input_text", text: "what is this?" });
    expect(parts[1]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,abc123", detail: "auto" });
  });
});

describe("responsesConvertParams — parallel tool_calls", () => {
  it("emits one function_call item per tool_call with call_id = tc.id", () => {
    const params = makeBase([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_111", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
          { id: "call_222", type: "function", function: { name: "write_file", arguments: '{"path":"b.ts"}' } },
        ],
      },
    ] as ChatCompletionCreateParamsNonStreaming["messages"]);
    const result = responsesConvertParams(params, {});
    const fcItems = (result.input as unknown[]).filter(
      (item) => (item as Record<string, unknown>).type === "function_call"
    ) as Record<string, unknown>[];
    expect(fcItems).toHaveLength(2);
    expect(fcItems[0].call_id).toBe("call_111");
    expect(fcItems[0].name).toBe("read_file");
    expect(fcItems[1].call_id).toBe("call_222");
    expect(fcItems[1].name).toBe("write_file");
  });
});

describe("responsesConvertParams — post-compaction two-system", () => {
  it("first system → instructions; second system → developer input item (not concatenated)", () => {
    const params = makeBase([
      { role: "system", content: "You are Zone." },
      { role: "user", content: "fix it" },
      {
        role: "system",
        content: "[compacted_history]\n## Summary\n[/compacted_history]",
      },
      { role: "user", content: "continue" },
    ] as ChatCompletionCreateParamsNonStreaming["messages"]);
    const result = responsesConvertParams(params, {});
    // instructions = first system only
    expect(result.instructions).toBe("You are Zone.");
    // developer item appears in input at the position of the second system
    const devItem = (result.input as unknown[]).find(
      (item) =>
        (item as Record<string, unknown>).type === "message" &&
        (item as Record<string, unknown>).role === "developer"
    ) as Record<string, unknown> | undefined;
    expect(devItem).toBeDefined();
    expect(devItem!.content).toContain("[compacted_history]");
    // second system content NOT merged into instructions
    expect(result.instructions).not.toContain("[compacted_history]");
  });
});

describe("responsesConvertParams — content + tool_calls (fidelity gap fix)", () => {
  it("emits output_text message item BEFORE function_call items when content is non-empty", () => {
    const params = makeBase([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "thinking about it",
        tool_calls: [
          { id: "call_xyz", type: "function", function: { name: "read_file", arguments: '{"path":"x.ts"}' } },
        ],
      },
    ] as ChatCompletionCreateParamsNonStreaming["messages"]);
    const result = responsesConvertParams(params, {});
    const assistantItems = (result.input as unknown[]).filter(
      (item) =>
        (item as Record<string, unknown>).type === "message" &&
        (item as Record<string, unknown>).role === "assistant"
    ) as Record<string, unknown>[];
    expect(assistantItems).toHaveLength(1);
    const textContent = (assistantItems[0].content as Record<string, unknown>[])[0];
    expect(textContent).toMatchObject({ type: "output_text", text: "thinking about it" });

    // The function_call item must come AFTER the output_text message
    const allItems = result.input as unknown[];
    const msgIdx = allItems.findIndex(
      (item) =>
        (item as Record<string, unknown>).type === "message" &&
        (item as Record<string, unknown>).role === "assistant"
    );
    const fcIdx = allItems.findIndex(
      (item) => (item as Record<string, unknown>).type === "function_call"
    );
    expect(fcIdx).toBeGreaterThan(msgIdx);
  });

  it("does NOT emit output_text message item when content is null", () => {
    const params = makeBase([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_xyz", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
    ] as ChatCompletionCreateParamsNonStreaming["messages"]);
    const result = responsesConvertParams(params, {});
    const assistantMsgItems = (result.input as unknown[]).filter(
      (item) =>
        (item as Record<string, unknown>).type === "message" &&
        (item as Record<string, unknown>).role === "assistant"
    );
    expect(assistantMsgItems).toHaveLength(0);
  });
});
