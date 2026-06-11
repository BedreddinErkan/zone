import { describe, it, expect } from "vitest";
import { responsesConvertResponse } from "./responsesConvertResponse.js";
import type { Response as OpenAIResponse } from "openai/resources/responses/responses.js";

function makeResponse(overrides: Partial<OpenAIResponse> = {}): OpenAIResponse {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1000,
    model: "gpt-5.4",
    output: [],
    output_text: "",
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  } as unknown as OpenAIResponse;
}

describe("responsesConvertResponse — call_id trap (§2 load-bearing)", () => {
  it("tool_calls[].id === function_call.call_id, NOT the fc_ item id", () => {
    const response = makeResponse({
      output: [
        {
          type: "function_call",
          id: "fc_XXXXXXXXX",
          call_id: "call_abc123",
          name: "read_file",
          arguments: '{"path":"x.ts"}',
          status: "completed",
        },
      ] as unknown as OpenAIResponse["output"],
    });
    const result = responsesConvertResponse(response);
    const tc = result.choices[0].message.tool_calls?.[0];
    expect(tc).toBeDefined();
    expect(tc!.id).toBe("call_abc123");
    expect(tc!.id).not.toBe("fc_XXXXXXXXX");
    expect(tc!.function.name).toBe("read_file");
  });
});

describe("responsesConvertResponse — parallel function_calls", () => {
  it("two function_call items → tool_calls length 2 with correct call_ids", () => {
    const response = makeResponse({
      output: [
        { type: "function_call", id: "fc_1", call_id: "call_111", name: "read_file", arguments: '{"path":"a.ts"}', status: "completed" },
        { type: "function_call", id: "fc_2", call_id: "call_222", name: "write_file", arguments: '{"path":"b.ts"}', status: "completed" },
      ] as unknown as OpenAIResponse["output"],
    });
    const result = responsesConvertResponse(response);
    expect(result.choices[0].message.tool_calls).toHaveLength(2);
    expect(result.choices[0].message.tool_calls![0].id).toBe("call_111");
    expect(result.choices[0].message.tool_calls![1].id).toBe("call_222");
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("responsesConvertResponse — plain text response", () => {
  it("no function_calls → finish_reason stop, content populated, no tool_calls", () => {
    const response = makeResponse({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Here is the answer.", annotations: [] }],
          id: "msg_1",
          status: "completed",
        },
      ] as unknown as OpenAIResponse["output"],
    });
    const result = responsesConvertResponse(response);
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.choices[0].message.content).toBe("Here is the answer.");
    expect(result.choices[0].message.tool_calls).toBeUndefined();
  });
});

describe("responsesConvertResponse — refusal / failed status", () => {
  it("status:failed sets message.refusal from error.message", () => {
    const response = makeResponse({
      status: "failed" as OpenAIResponse["status"],
      error: { code: "server_error", message: "Request failed" } as OpenAIResponse["error"],
      output: [],
    });
    const result = responsesConvertResponse(response);
    expect(result.choices[0].message.refusal).toBe("Request failed");
  });

  it("status:failed with no error message falls back to 'Response failed'", () => {
    const response = makeResponse({
      status: "failed" as OpenAIResponse["status"],
      error: null,
      output: [],
    });
    const result = responsesConvertResponse(response);
    expect(result.choices[0].message.refusal).toBe("Response failed");
  });
});

describe("responsesConvertResponse — incomplete response", () => {
  it("incomplete_details present → finish_reason:length", () => {
    const response = makeResponse({
      status: "incomplete" as OpenAIResponse["status"],
      incomplete_details: { reason: "max_output_tokens" } as OpenAIResponse["incomplete_details"],
      output: [],
    });
    const result = responsesConvertResponse(response);
    expect(result.choices[0].finish_reason).toBe("length");
  });
});

describe("responsesConvertResponse — usage mapping", () => {
  it("maps input/output tokens and cached_tokens to Chat shape", () => {
    const response = makeResponse({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens_details: { reasoning_tokens: 10 },
      } as OpenAIResponse["usage"],
    });
    const result = responsesConvertResponse(response);
    const usage = result.usage!;
    expect(usage.prompt_tokens).toBe(100);
    expect(usage.completion_tokens).toBe(50);
    expect(usage.total_tokens).toBe(150);
    const details = (usage as Record<string, unknown>).prompt_tokens_details as Record<string, unknown>;
    expect(details?.cached_tokens).toBe(30);
  });

  it("guards undefined usage — all fields default to 0", () => {
    const response = makeResponse({ usage: undefined });
    const result = responsesConvertResponse(response);
    const usage = result.usage!;
    expect(usage.prompt_tokens).toBe(0);
    expect(usage.completion_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
  });

  it("preserves reasoning_tokens in completion_tokens_details (subset of completion_tokens, not added on top)", () => {
    const response = makeResponse({
      usage: {
        input_tokens: 10,
        output_tokens: 50,
        total_tokens: 60,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 42 },
      } as OpenAIResponse["usage"],
    });
    const result = responsesConvertResponse(response);
    const details = (result.usage as Record<string, unknown>)
      .completion_tokens_details as Record<string, unknown>;
    expect(details.reasoning_tokens).toBe(42);
    // completion_tokens must NOT include reasoning_tokens again
    expect(result.usage!.completion_tokens).toBe(50);
  });

  it("defaults reasoning_tokens to 0 when output_tokens_details absent", () => {
    const response = makeResponse({ usage: undefined });
    const result = responsesConvertResponse(response);
    const details = (result.usage as Record<string, unknown>)
      .completion_tokens_details as Record<string, unknown>;
    expect(details.reasoning_tokens).toBe(0);
  });
});

describe("responsesConvertResponse — reasoning items discarded (S4 seam dormant)", () => {
  it("reasoning items do not appear in message; function_call does appear in tool_calls", () => {
    const response = makeResponse({
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [],
          encrypted_content: "OPAQUE_BLOB",
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_999",
          name: "read_file",
          arguments: "{}",
          status: "completed",
        },
      ] as unknown as OpenAIResponse["output"],
    });
    const result = responsesConvertResponse(response);
    const msg = result.choices[0].message;
    // Reasoning must not appear anywhere in message
    expect(JSON.stringify(msg)).not.toContain("OPAQUE_BLOB");
    expect(JSON.stringify(msg)).not.toContain("reasoning");
    // Tool call must be present
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0].id).toBe("call_999");
  });
});

describe("responsesConvertResponse — model + id echo", () => {
  it("echoes model and id from response", () => {
    const response = makeResponse({ model: "gpt-5.4", id: "resp_42" });
    const result = responsesConvertResponse(response);
    expect(result.model).toBe("gpt-5.4");
    expect(result.id).toBe("resp_42");
    expect(result.object).toBe("chat.completion");
  });
});
