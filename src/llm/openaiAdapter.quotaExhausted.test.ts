/**
 * item 411 — an OpenAI quota-exhausted 429 must reach the caller as a ProviderRequestError
 * (kind:"credit"), the same typed class Anthropic's credit-exhaustion mapping already uses and
 * that dispatch.ts/cli/tui/index.tsx already render with dedicated, prominent handling — not as
 * a raw SDK error or an UpstreamUnavailableError from a wasted retry budget.
 *
 * Isolated from openaiAdapter.test.ts deliberately: that file's shared mock factory for
 * withExponentialBackoff.js provides only `withExponentialBackoff` and never injects an error, so
 * none of its cases exercise this path. Mocking it here separately keeps that file untouched.
 */
import { describe, expect, it, vi } from "vitest";
import { APIError as OpenAIAPIError } from "openai";
import { ProviderRequestError } from "./factory.js";

const sdkCreateMock = vi.fn();
const sdkResponsesCreateMock = vi.fn();
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  return {
    ...actual,
    default: class FakeOpenAI {
      chat = { completions: { create: sdkCreateMock } };
      responses = { create: sdkResponsesCreateMock };
    },
  };
});
// Real withExponentialBackoff would genuinely retry a real 429 four times (5s/15s/45s real
// delays) before giving up — this file tests the .catch(mapOpenAIQuotaExhausted) mapping layer in
// isolation, not retry timing, which withExponentialBackoff.test.ts already covers exhaustively.
// Mirrors openaiAdapter.test.ts's own mock shape exactly: call fn() once, no retry.
vi.mock("./withExponentialBackoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./withExponentialBackoff.js")>();
  return {
    ...actual,
    withExponentialBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});
vi.mock("./modelRegistry.js", () => ({
  supportsEffort: vi.fn().mockReturnValue(false),
  resolveEffortForModel: vi.fn().mockReturnValue(undefined),
  normalizeModelId: vi.fn((id: string) => id),
}));

import { OpenAIAdapter } from "./openaiAdapter.js";

function quotaExhaustedError(): OpenAIAPIError {
  return OpenAIAPIError.generate(
    429,
    { error: { type: "insufficient_quota", code: "insufficient_quota", message: "no credit" } },
    "no credit",
    new Headers()
  );
}

function ordinaryRateLimitError(): OpenAIAPIError {
  return OpenAIAPIError.generate(429, { error: { message: "Rate limit reached for requests" } }, "rate limited", new Headers());
}

const FAKE_COMPLETION = {
  id: "chatcmpl-test",
  model: "gpt-4o",
  choices: [{ message: { content: "hi", tool_calls: null }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe("OpenAIAdapter — quota-exhausted 429 mapping (item 411)", () => {
  it("createChatCompletion: quota exhaustion throws ProviderRequestError(kind:'credit')", async () => {
    sdkCreateMock.mockRejectedValueOnce(quotaExhaustedError());
    const adapter = new OpenAIAdapter("test-key");

    let caught: unknown;
    try {
      await adapter.createChatCompletion({ model: "gpt-4o", messages: [] });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderRequestError);
    const err = caught as ProviderRequestError;
    expect(err.kind).toBe("credit");
    expect(err.userMessage).toContain("API credit exhausted");
    expect(err.userMessage).toContain("platform.openai.com");
  });

  it("createChatCompletion: an ordinary rate-limit 429 is rethrown unchanged — no over-match", async () => {
    const rateLimitErr = ordinaryRateLimitError();
    sdkCreateMock.mockRejectedValueOnce(rateLimitErr);
    const adapter = new OpenAIAdapter("test-key");

    await expect(adapter.createChatCompletion({ model: "gpt-4o", messages: [] })).rejects.toBe(rateLimitErr);
  });

  it("createChatCompletion: an unrelated error is rethrown unchanged", async () => {
    const genericErr = new Error("network hiccup");
    sdkCreateMock.mockRejectedValueOnce(genericErr);
    const adapter = new OpenAIAdapter("test-key");

    await expect(adapter.createChatCompletion({ model: "gpt-4o", messages: [] })).rejects.toBe(genericErr);
  });

  it("createChatCompletion: gpt-5.x (responses.create path) also maps quota exhaustion", async () => {
    sdkResponsesCreateMock.mockRejectedValueOnce(quotaExhaustedError());
    const adapter = new OpenAIAdapter("test-key", undefined, "openai");

    let caught: unknown;
    try {
      await adapter.createChatCompletion({ model: "gpt-5.5", messages: [] });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).kind).toBe("credit");
  });

  it("createChatCompletionStream: quota exhaustion also maps to ProviderRequestError(kind:'credit')", async () => {
    sdkCreateMock.mockRejectedValueOnce(quotaExhaustedError());
    const adapter = new OpenAIAdapter("test-key");

    let caught: unknown;
    try {
      await adapter.createChatCompletionStream({ model: "gpt-4o", messages: [], stream: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).kind).toBe("credit");
  });

  it("createChatCompletion: success path is unaffected by the new .catch()", async () => {
    sdkCreateMock.mockResolvedValueOnce(FAKE_COMPLETION);
    const adapter = new OpenAIAdapter("test-key");

    const result = await adapter.createChatCompletion({ model: "gpt-4o", messages: [] });
    expect(result).toEqual(FAKE_COMPLETION);
  });
});
