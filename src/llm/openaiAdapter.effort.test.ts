import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions";

const stubCompletion: ChatCompletion = {
  id: "test-id",
  object: "chat.completion",
  created: 0,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "ok", refusal: null },
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const stubResponsesResponse = {
  id: "resp_test",
  object: "response",
  created_at: 0,
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
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

// Use vi.hoisted so these are available inside vi.mock factory scope.
const mocks = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
  mockResponsesCreate: vi.fn(),
  mockOpenAI: vi.fn(),
}));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  return {
    ...actual,
    default: mocks.mockOpenAI,
  };
});

beforeEach(() => {
  // mockReset: true resets all vi.fn() between tests; re-apply all implementations here.
  mocks.mockChatCreate.mockResolvedValue(stubCompletion);
  mocks.mockResponsesCreate.mockResolvedValue(stubResponsesResponse);
  mocks.mockOpenAI.mockImplementation(() => ({
    chat: { completions: { create: mocks.mockChatCreate } },
    responses: { create: mocks.mockResponsesCreate },
  }));
});

describe("OpenAIAdapter — effort/reasoning_effort wiring", () => {
  it("gpt-5.4 + effort=high routes to Responses API (S7 — effort handled in responsesConvertParams)", async () => {
    const { OpenAIAdapter } = await import("./openaiAdapter.js");
    const adapter = new OpenAIAdapter("test-key");

    await adapter.createChatCompletion(
      { model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] },
      { effort: "high" }
    );

    // gpt-5.x always goes through responses.create after S7; reasoning_effort wiring
    // for gpt-5 is tested in responsesConvertParams.test.ts.
    expect(mocks.mockResponsesCreate).toHaveBeenCalledOnce();
    expect(mocks.mockChatCreate).not.toHaveBeenCalled();
  });

  it("omits reasoning_effort when model does not support it (gpt-4o)", async () => {
    const { OpenAIAdapter } = await import("./openaiAdapter.js");
    const adapter = new OpenAIAdapter("test-key");

    await adapter.createChatCompletion(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      { effort: "high" }
    );

    expect(mocks.mockChatCreate).toHaveBeenCalledOnce();
    const calledParams = mocks.mockChatCreate.mock.calls[0][0];
    expect(calledParams.reasoning_effort).toBeUndefined();
  });
});
