import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";

// Module-level mock fns — class approach defers property access until new FakeOpenAI(),
// so they are defined by the time any test runs (no vi.hoisted needed).
const mockResponsesCreate = vi.fn();
const mockChatCreate = vi.fn();

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    responses = { create: mockResponsesCreate };
    chat = { completions: { create: mockChatCreate } };
    embeddings = { create: vi.fn() };
  },
}));

vi.mock("./withExponentialBackoff.js", () => ({
  withExponentialBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Mocked for loadCliConfig tests — same absolute path regardless of which file imports it.
vi.mock("../api/diskModel.js", () => ({
  loadDiskModelSync: vi.fn(() => null),
}));
vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: vi.fn(() => undefined),
}));

import { OpenAIAdapter } from "./openaiAdapter.js";
import { loadCliConfig } from "../cli/config.js";
import { getModelName } from "./openaiClient.js";

const MOCK_RESPONSE = {
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

const MOCK_CHAT_COMPLETION = {
  id: "chatcmpl_test",
  object: "chat.completion",
  created: 0,
  model: "gpt-4o",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "ok", refusal: null },
    finish_reason: "stop",
    logprobs: null,
  }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
};

const BASE_MESSAGES: ChatCompletionCreateParamsNonStreaming["messages"] = [
  { role: "user", content: "hello" },
];

beforeEach(() => {
  mockResponsesCreate.mockResolvedValue(MOCK_RESPONSE);
  mockChatCreate.mockResolvedValue(MOCK_CHAT_COMPLETION);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("S3 routing — Responses API branch", () => {
  it("gpt-5.4 + openai → responses.create called with NO env flag (S7 core assertion)", async () => {
    const adapter = new OpenAIAdapter("sk-test");
    const result = await adapter.createChatCompletion({
      model: "gpt-5.4",
      messages: BASE_MESSAGES,
      stream: false,
    });
    expect(mockResponsesCreate).toHaveBeenCalledOnce();
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(result.object).toBe("chat.completion");
  });

  it("gpt-5.4 + openai → responses.create called, chat.completions NOT, returns ChatCompletion shape", async () => {
    const adapter = new OpenAIAdapter("sk-test");
    const result = await adapter.createChatCompletion({
      model: "gpt-5.4",
      messages: BASE_MESSAGES,
      stream: false,
    });
    expect(mockResponsesCreate).toHaveBeenCalledOnce();
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(result.object).toBe("chat.completion");
  });

  it("gpt-4o + openai → chat.completions.create called, responses NOT", async () => {
    const adapter = new OpenAIAdapter("sk-test");
    await adapter.createChatCompletion({
      model: "gpt-4o",
      messages: BASE_MESSAGES,
      stream: false,
    });
    expect(mockChatCreate).toHaveBeenCalledOnce();
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });

  it("gpt-5.4 + provider=anthropic → chat.completions.create called (this.provider guard)", async () => {
    const adapter = new OpenAIAdapter("sk-test", undefined, "anthropic");
    await adapter.createChatCompletion({
      model: "gpt-5.4",
      messages: BASE_MESSAGES,
      stream: false,
    });
    expect(mockChatCreate).toHaveBeenCalledOnce();
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });
});

describe("S3 stream guard", () => {
  it("gpt-5.4 → createChatCompletionStream throws deferred-to-S6 error", async () => {
    const adapter = new OpenAIAdapter("sk-test");
    await expect(
      adapter.createChatCompletionStream({
        model: "gpt-5.4",
        messages: BASE_MESSAGES,
        stream: true,
      } as ChatCompletionCreateParamsStreaming)
    ).rejects.toThrow("deferred to S6");
  });

  it("gpt-4o → createChatCompletionStream does NOT throw", async () => {
    const adapter = new OpenAIAdapter("sk-test");
    await expect(
      adapter.createChatCompletionStream({
        model: "gpt-4o",
        messages: BASE_MESSAGES,
        stream: true,
      } as ChatCompletionCreateParamsStreaming)
    ).resolves.toBeDefined();
  });
});

describe("S7 — config.ts (loadCliConfig)", () => {
  it("gpt-5.4 + openai → NOT rewritten to gpt-4o (no flag needed)", () => {
    const cfg = loadCliConfig({ model: "gpt-5.4", provider: "openai" }, {});
    expect(cfg.model).toBe("gpt-5.4");
  });
});

describe("S7 — openaiClient.ts (getModelName)", () => {
  it("getModelName returns gpt-5.4 candidate as-is (no flag needed)", () => {
    const result = getModelName("high", "openai", { high: "gpt-5.4" });
    expect(result).toBe("gpt-5.4");
  });
});
