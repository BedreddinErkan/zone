/**
 * Streaming-call retry — verifies _streamWithToolCallbacks retry behaviour.
 *
 * Scenarios:
 *  1. Retryable network error → retried → success (stream path)
 *  2. Streaming exhausts retries → non-streaming fallback succeeds
 *  3. Both streaming and non-streaming exhaust → UpstreamUnavailableError propagates
 *  4. AbortError during stream → non-retryable, propagates immediately
 *  5. 400 BadRequest during stream → mapAnthropicBadRequest → ProviderRequestError
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  APIConnectionError,
  APIUserAbortError,
  APIError as AnthropicAPIError,
} from "@anthropic-ai/sdk";
import { AnthropicAdapter } from "./anthropicAdapter.js";
import { UpstreamUnavailableError } from "./withExponentialBackoff.js";
import { ProviderRequestError } from "./factory.js";

// ── Hoisted SDK mock ──────────────────────────────────────────────────────────

const mockMessages = vi.hoisted(() => ({
  stream: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  return {
    ...actual,
    default: vi.fn(() => ({ messages: mockMessages })),
  };
});

// ── Stream helpers ────────────────────────────────────────────────────────────

/** An async iterable that throws `err` on the first iteration. */
function failingStream(err: Error) {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          throw err;
        },
      };
    },
  };
}

/** A minimal Anthropic event stream producing a text message. */
function successStream(text = "OK") {
  const events: unknown[] = [
    { type: "message_start", message: { id: "msg-1", model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 2 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return {
    [Symbol.asyncIterator]() {
      let idx = 0;
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (idx < events.length) return { value: events[idx++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/** Minimal Anthropic message response for non-streaming mocks. */
function makeAnthropicMessage(text = "Fallback") {
  return {
    id: "msg-fallback",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-opus-4-8",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/** Make a BadRequestError via the SDK factory (same pattern as badRequest.test.ts). */
function makeBadRequest400(innerType: string, msg: string) {
  return AnthropicAPIError.generate(
    400,
    { type: "error", error: { type: innerType, message: msg } },
    "400 Bad Request",
    new Headers(),
  );
}

function makeAdapter() {
  return new AnthropicAdapter("sk-test");
}

// Params that trigger the streaming path (onToolArgumentsDelta required).
const STREAMING_OPTS = { onToolArgumentsDelta: vi.fn() };
const BASE_PARAMS = {
  model: "claude-opus-4-8",
  messages: [{ role: "user" as const, content: "hi" }],
  max_tokens: 256,
};

// ── Test lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe("_streamWithToolCallbacks — retry behaviour", () => {
  it("1. retryable network error → retried → success on second attempt", async () => {
    const networkErr = new APIConnectionError({ message: "ECONNRESET" });
    mockMessages.stream
      .mockReturnValueOnce(failingStream(networkErr))
      .mockReturnValueOnce(successStream("Retry worked"));

    const adapter = makeAdapter();
    const promise = adapter.createChatCompletion(BASE_PARAMS, STREAMING_OPTS);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.choices[0].message.content).toBe("Retry worked");
    expect(mockMessages.stream).toHaveBeenCalledTimes(2);
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it("2. streaming exhausts → non-streaming fallback succeeds", async () => {
    const networkErr = new APIConnectionError({ message: "drop" });
    // general5xx: maxAttempts=3 → 4 total stream calls before UpstreamUnavailableError
    mockMessages.stream.mockReturnValue(failingStream(networkErr));
    mockMessages.create.mockResolvedValue(makeAnthropicMessage("Fallback text"));

    const adapter = makeAdapter();
    const promise = adapter.createChatCompletion(BASE_PARAMS, STREAMING_OPTS);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.choices[0].message.content).toBe("Fallback text");
    expect(mockMessages.stream).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(mockMessages.create).toHaveBeenCalledTimes(1);
  });

  it("3. both streaming and non-streaming exhaust → UpstreamUnavailableError propagates", async () => {
    const networkErr = new APIConnectionError({ message: "drop" });
    mockMessages.stream.mockReturnValue(failingStream(networkErr));
    // non-streaming also fails
    mockMessages.create.mockRejectedValue(networkErr);

    const adapter = makeAdapter();
    const promise = adapter.createChatCompletion(BASE_PARAMS, STREAMING_OPTS);
    promise.catch(() => {}); // prevent unhandled-rejection before .rejects resolves
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(mockMessages.stream).toHaveBeenCalledTimes(4);
    expect(mockMessages.create).toHaveBeenCalledTimes(4); // fallback also retries
  });

  it("4. AbortError during stream → non-retryable, propagates immediately without retry", async () => {
    const abortErr = new APIUserAbortError();
    mockMessages.stream.mockReturnValueOnce(failingStream(abortErr));

    const adapter = makeAdapter();
    const promise = adapter.createChatCompletion(BASE_PARAMS, STREAMING_OPTS);
    promise.catch(() => {}); // prevent unhandled-rejection before .rejects resolves
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(APIUserAbortError);
    expect(mockMessages.stream).toHaveBeenCalledTimes(1); // no retry
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it("5. 400 BadRequest during stream → non-retryable → ProviderRequestError via mapAnthropicBadRequest", async () => {
    const badReq = makeBadRequest400("invalid_request_error", "model not found");
    mockMessages.stream.mockReturnValueOnce(failingStream(badReq));

    const adapter = makeAdapter();
    const promise = adapter.createChatCompletion(BASE_PARAMS, STREAMING_OPTS);
    promise.catch(() => {}); // prevent unhandled-rejection before .rejects resolves
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(ProviderRequestError);
    const err = await promise.catch((e) => e) as ProviderRequestError;
    expect(err.kind).toBe("request_shape");
    expect(err.status).toBe(400);
    expect(mockMessages.stream).toHaveBeenCalledTimes(1); // no retry for 400
    expect(mockMessages.create).not.toHaveBeenCalled();
  });
});
