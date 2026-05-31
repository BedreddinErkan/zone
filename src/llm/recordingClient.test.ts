import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../usage/usageTracker.js", () => ({
  recordExecution: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./openaiContext.js", () => ({
  getRequestContext: vi.fn().mockReturnValue(undefined),
}));

import { vi as viMock } from "vitest";
import { recordExecution } from "../usage/usageTracker.js";
import { RecordingLLMClient } from "./recordingClient.js";
import type { LLMClient } from "./types.js";

function makeFakeStream(usage: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [], model: "m", usage };
    },
  };
}

function makeFakeInner(provider: "openai" | "anthropic" | "gemini", streamFn?: ReturnType<typeof vi.fn>) {
  return {
    provider,
    createChatCompletionStream: streamFn ?? vi.fn().mockResolvedValue(
      makeFakeStream({ prompt_tokens: 100, completion_tokens: 50 })
    ),
    createChatCompletion: vi.fn(),
    createEmbedding: vi.fn(),
  } as unknown as LLMClient;
}

describe("toProviderName — gemini not mis-billed as openai", () => {
  beforeEach(() => { vi.mocked(recordExecution).mockClear(); });

  it("gemini provider → recordExecution called with provider='gemini'", async () => {
    const client = new RecordingLLMClient(makeFakeInner("gemini"));
    const stream = await client.createChatCompletionStream(
      { model: "gemini-3.5-flash", messages: [], stream: true }
    );
    for await (const _ of stream) {}
    expect(vi.mocked(recordExecution)).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gemini" })
    );
  });

  it("openai provider → recordExecution called with provider='openai'", async () => {
    const client = new RecordingLLMClient(makeFakeInner("openai"));
    const stream = await client.createChatCompletionStream(
      { model: "gpt-5.4", messages: [], stream: true }
    );
    for await (const _ of stream) {}
    expect(vi.mocked(recordExecution)).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" })
    );
  });
});

describe("stream_options.include_usage — set for openai and gemini, not anthropic", () => {
  it("gemini: include_usage:true injected into stream params", async () => {
    const streamFn = vi.fn().mockResolvedValue(makeFakeStream(null));
    const client = new RecordingLLMClient(makeFakeInner("gemini", streamFn));
    await client.createChatCompletionStream(
      { model: "gemini-3.5-flash", messages: [], stream: true }
    );
    expect(streamFn).toHaveBeenCalledWith(
      expect.objectContaining({ stream_options: { include_usage: true } }),
      expect.anything()
    );
  });

  it("openai: include_usage:true injected", async () => {
    const streamFn = vi.fn().mockResolvedValue(makeFakeStream(null));
    const client = new RecordingLLMClient(makeFakeInner("openai", streamFn));
    await client.createChatCompletionStream(
      { model: "gpt-5.4", messages: [], stream: true }
    );
    expect(streamFn).toHaveBeenCalledWith(
      expect.objectContaining({ stream_options: { include_usage: true } }),
      expect.anything()
    );
  });

  it("anthropic: include_usage NOT injected", async () => {
    const streamFn = vi.fn().mockResolvedValue(makeFakeStream(null));
    const client = new RecordingLLMClient(makeFakeInner("anthropic", streamFn));
    await client.createChatCompletionStream(
      { model: "claude-sonnet-4-6", messages: [], stream: true }
    );
    const calledWith = streamFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledWith?.stream_options).toBeUndefined();
  });
});
