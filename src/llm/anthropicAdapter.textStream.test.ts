/**
 * onTextDelta — the assistant-text streaming callback (ledger item 327).
 *
 * Drives the REAL AnthropicAdapter and the REAL convertStream through a hoisted SDK mock, so
 * these assertions cover the actual delta-surfacing path rather than a re-implementation of it.
 *
 * The fragment strings below are NOT invented: they are the literal `delta` payloads observed at
 * the bus during an instrumented research-shaped run (n=1). An earlier version of this work
 * assumed the adapter consumed Anthropic's raw `content_block_delta`/`text_delta` shape directly;
 * it does not — it reads the already-normalised `delta.content` that convertStream produces from
 * those events. Building the mock from the assumed shape rather than the observed one would have
 * meant killing mutations against a fiction, so the events here are raw `text_delta` (what the
 * SDK actually yields) and the assertions are on the normalised fragments (what the adapter
 * actually forwards).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicAdapter } from "./anthropicAdapter.js";

const mockMessages = vi.hoisted(() => ({
  stream: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  return { ...actual, default: vi.fn(() => ({ messages: mockMessages })) };
});

/** Literal fragments observed at the bus during the instrumented run. */
const OBSERVED_FRAGMENTS = [
  "Reading",
  " the queue implementation to understand its structure.",
  "##",
  " How `TaskQueue` Works\n\n### Class anatomy (`src/queue.ts`)\n\n`TaskQueue` is a thin wrapper around a plain",
];

function textStream(fragments: string[]) {
  const events: unknown[] = [
    { type: "message_start", message: { id: "msg-1", model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 2 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...fragments.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
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
    // Without this the adapter's thinking-capture warns on a fail-soft path — harmless to the
    // assertions, noisy in output.
    finalMessage: async () => ({ id: "msg-1", content: [], role: "assistant", model: "claude-sonnet-4-6" }),
  };
}

const BASE_PARAMS = {
  model: "claude-sonnet-4-6",
  messages: [{ role: "user" as const, content: "explain the queue" }],
  max_tokens: 256,
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe("onTextDelta — assistant-text fragments surfaced from the streaming path", () => {
  it("fires once per fragment, in order, with the exact payloads the stream carried", async () => {
    const onTextDelta = vi.fn();
    mockMessages.stream.mockReturnValue(textStream(OBSERVED_FRAGMENTS));

    // onToolArgumentsDelta is required: the adapter branches into the streaming path on THAT
    // callback alone, so onTextDelta by itself would never stream (see ledger entry on the
    // coupling). Passing both is what production does.
    await new AnthropicAdapter("sk-test").createChatCompletion(BASE_PARAMS, {
      onToolArgumentsDelta: vi.fn(),
      onTextDelta,
    });

    expect(onTextDelta).toHaveBeenCalledTimes(OBSERVED_FRAGMENTS.length);
    expect(onTextDelta.mock.calls.map((c) => c[0])).toEqual(OBSERVED_FRAGMENTS);
  });

  it("the assembled response still carries the full concatenated text — surfacing deltas does not consume them", async () => {
    mockMessages.stream.mockReturnValue(textStream(OBSERVED_FRAGMENTS));

    const res = await new AnthropicAdapter("sk-test").createChatCompletion(BASE_PARAMS, {
      onToolArgumentsDelta: vi.fn(),
      onTextDelta: vi.fn(),
    });

    expect(res.choices[0]?.message.content).toBe(OBSERVED_FRAGMENTS.join(""));
  });

  it("does NOT fall back to the non-streaming path — a silent fallback would make a broken stream look healthy", async () => {
    mockMessages.stream.mockReturnValue(textStream(OBSERVED_FRAGMENTS));

    await new AnthropicAdapter("sk-test").createChatCompletion(BASE_PARAMS, {
      onToolArgumentsDelta: vi.fn(),
      onTextDelta: vi.fn(),
    });

    // Left deliberately unmocked: if a mutation broke streaming and the adapter fell back,
    // messages.create would be reached and this assertion turns a passing mutation into a failure.
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it("negative control — an empty-text stream fires no text deltas, so a non-zero count above means something", async () => {
    const onTextDelta = vi.fn();
    mockMessages.stream.mockReturnValue(textStream([]));

    await new AnthropicAdapter("sk-test").createChatCompletion(BASE_PARAMS, {
      onToolArgumentsDelta: vi.fn(),
      onTextDelta,
    });

    expect(onTextDelta).not.toHaveBeenCalled();
  });
});
