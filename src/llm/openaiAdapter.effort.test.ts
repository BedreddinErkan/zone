import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions";

const stubCompletion: ChatCompletion = {
  id: "test-id",
  object: "chat.completion",
  created: 0,
  model: "gpt-5.4",
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

// Use vi.hoisted so these are available inside vi.mock factory scope.
const mocks = vi.hoisted(() => ({
  mockCreate: vi.fn(),
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
  mocks.mockCreate.mockResolvedValue(stubCompletion);
  mocks.mockOpenAI.mockImplementation(() => ({
    chat: { completions: { create: mocks.mockCreate } },
  }));
});

describe("OpenAIAdapter — effort/reasoning_effort wiring", () => {
  it("passes reasoning_effort to SDK when effort=high and model supports it (gpt-5.4)", async () => {
    const { OpenAIAdapter } = await import("./openaiAdapter.js");
    const adapter = new OpenAIAdapter("test-key");

    await adapter.createChatCompletion(
      { model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] },
      { effort: "high" }
    );

    expect(mocks.mockCreate).toHaveBeenCalledOnce();
    const calledParams = mocks.mockCreate.mock.calls[0][0];
    expect(calledParams.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort when model does not support it (gpt-4o)", async () => {
    const { OpenAIAdapter } = await import("./openaiAdapter.js");
    const adapter = new OpenAIAdapter("test-key");

    await adapter.createChatCompletion(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      { effort: "high" }
    );

    expect(mocks.mockCreate).toHaveBeenCalledOnce();
    const calledParams = mocks.mockCreate.mock.calls[0][0];
    expect(calledParams.reasoning_effort).toBeUndefined();
  });
});
