/**
 * Request-duration configuration for the Anthropic adapter.
 *
 * A non-streaming request holds one connection for the whole generation, so its
 * timeout has to scale with the output budget. Two things must hold together:
 * the SDK's per-request timeout is derived from max_tokens, and the transport's
 * timers sit above every value that derivation can produce — otherwise undici cuts
 * first and the SDK timeout is decorative.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIConnectionTimeoutError, APIConnectionError } from "@anthropic-ai/sdk";
import {
  AnthropicAdapter,
  deriveRequestTimeoutMs,
  isTimeoutError,
  TRANSPORT_TIMEOUT_MS,
} from "./anthropicAdapter.js";
import { UpstreamUnavailableError } from "./withExponentialBackoff.js";

// ── Hoisted SDK mock (same shape as anthropicAdapter.streamRetry.test.ts) ──────

const mockMessages = vi.hoisted(() => ({
  stream: vi.fn(),
  create: vi.fn(),
}));
const mockCtor = vi.hoisted(() => vi.fn(() => ({ messages: mockMessages })));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  return { ...actual, default: mockCtor };
});

/** The vendor's own estimate, before Zone's margin — 128k output tokens ≈ 60 min. */
const vendorEstimateMs = (maxTokens: number) => ((60 * 60 * 1000) * maxTokens) / 128_000;

function okMessage() {
  return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", model: "m", id: "x",
    usage: { input_tokens: 1, output_tokens: 1 } };
}

beforeEach(() => {
  mockMessages.create.mockReset();
  mockMessages.stream.mockReset();
  mockCtor.mockClear();
});

describe("deriveRequestTimeoutMs", () => {
  it("small budgets get the floor, so nothing regresses versus the previous fixed value", () => {
    expect(deriveRequestTimeoutMs(4_096)).toBe(600_000);
    expect(deriveRequestTimeoutMs(8_192)).toBe(600_000);
    expect(deriveRequestTimeoutMs(0)).toBe(600_000);
    expect(deriveRequestTimeoutMs(undefined)).toBe(600_000);
  });

  it("the floor gives out around 10.6k tokens, where the derived value overtakes it", () => {
    // 600_000 / (28.125 ms per token × 2) ≈ 10_666. Pinned because it is the point
    // where behaviour stops matching the old fixed timeout, and because that same
    // ~10.6k figure is why bounding max_tokens alone could never have fixed this:
    // it sits below the 16_384 floor thinking models already use at high effort.
    expect(deriveRequestTimeoutMs(10_000)).toBe(600_000);
    expect(deriveRequestTimeoutMs(11_000)).toBeGreaterThan(600_000);
    expect(deriveRequestTimeoutMs(16_384)).toBe(921_600);
  });

  it("mid-range budgets scale with the output budget", () => {
    // 64k: vendor estimate 30 min, doubled to 60 min, which is also the ceiling.
    expect(deriveRequestTimeoutMs(64_000)).toBe(3_600_000);
    // 32k: vendor estimate 15 min, doubled to 30 min — below the ceiling, so the
    // margin is genuinely visible here rather than clamped away.
    expect(deriveRequestTimeoutMs(32_000)).toBe(1_800_000);
  });

  it("carries a real margin over the bare vendor estimate", () => {
    // The vendor number is a "should this be streaming?" threshold, not a deadline:
    // used raw, a request that fills its budget would abort at exactly its expected
    // completion time. This is the assertion that the margin exists.
    const budget = 32_000;
    expect(deriveRequestTimeoutMs(budget)).toBeGreaterThan(vendorEstimateMs(budget));
    expect(deriveRequestTimeoutMs(budget)).toBe(vendorEstimateMs(budget) * 2);
  });

  it("never exceeds the SDK's own one-hour maximum for a single request", () => {
    expect(deriveRequestTimeoutMs(128_000)).toBe(3_600_000);
    expect(deriveRequestTimeoutMs(1_000_000)).toBe(3_600_000);
  });

  it("is monotonic in the output budget", () => {
    const budgets = [0, 1_000, 8_192, 16_384, 32_000, 64_000, 128_000];
    const values = budgets.map(deriveRequestTimeoutMs);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });
});

describe("transport ceiling sits above every derivable request timeout", () => {
  it("holds across the whole input domain, not just at hand-picked constants", () => {
    // Swept rather than compared literal-to-literal so the relationship survives a
    // change to either constant. This ordering is what makes the SDK's abort the
    // single authority and stops undici cutting first.
    const budgets = [0, 1, 4_096, 16_384, 32_000, 64_000, 128_000, 200_000, 1_000_000];
    const maxDerived = Math.max(...budgets.map(deriveRequestTimeoutMs));
    expect(TRANSPORT_TIMEOUT_MS).toBeGreaterThan(maxDerived);
  });
});

describe("client construction", () => {
  it("passes an undici dispatcher, without which the timers stay at undici's 300s", () => {
    new AnthropicAdapter("sk-test");
    const opts = mockCtor.mock.calls[0]?.[0] as Record<string, unknown>;
    const fetchOptions = opts.fetchOptions as { dispatcher?: unknown } | undefined;
    expect(fetchOptions?.dispatcher).toBeDefined();
  });

  it("keeps a positive constructor timeout, which is what keeps the SDK guard skipped", () => {
    // messages.js runs its "streaming is required for long operations" check only
    // when the constructor timeout is null. A non-null value keeps it skipped.
    new AnthropicAdapter("sk-test");
    const opts = mockCtor.mock.calls[0]?.[0] as { timeout?: unknown };
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout as number).toBeGreaterThan(0);
  });
});

describe("per-request timeout reaches the SDK", () => {
  it("non-streaming call passes a timeout derived from its own max_tokens", async () => {
    mockMessages.create.mockResolvedValue(okMessage());
    const adapter = new AnthropicAdapter("sk-test");

    await adapter.createChatCompletion({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 32_000,
    });

    const [, requestOptions] = mockMessages.create.mock.calls[0] as [unknown, { timeout?: number }];
    expect(requestOptions.timeout).toBe(deriveRequestTimeoutMs(32_000));
  });

  it("a larger budget produces a larger timeout on the same path", async () => {
    mockMessages.create.mockResolvedValue(okMessage());
    const adapter = new AnthropicAdapter("sk-test");

    await adapter.createChatCompletion({
      model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], max_tokens: 8_000,
    });
    await adapter.createChatCompletion({
      model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], max_tokens: 64_000,
    });

    const first = (mockMessages.create.mock.calls[0] as [unknown, { timeout: number }])[1].timeout;
    const second = (mockMessages.create.mock.calls[1] as [unknown, { timeout: number }])[1].timeout;
    expect(second).toBeGreaterThan(first);
  });
});

describe("streaming fallback does not run after a timeout", () => {
  /** A stream that rejects on first iteration with the given error. */
  function failingStream(err: Error) {
    return {
      [Symbol.asyncIterator]() {
        return { async next(): Promise<IteratorResult<unknown>> { throw err; } };
      },
      finalMessage: async () => okMessage(),
    };
  }

  /** Drives the real retry backoff without waiting on it — these paths exhaust
   *  withExponentialBackoff, whose sleeps would otherwise add ~30s to the suite. */
  async function settleWithFakeTimers<T>(work: Promise<T>): Promise<T> {
    vi.useFakeTimers();
    try {
      const advancing = (async () => {
        for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(5_000);
      })();
      const result = await work;
      await advancing;
      return result;
    } finally {
      vi.useRealTimers();
    }
  }

  it("a timed-out stream rethrows instead of re-issuing the same budget unstreamed", async () => {
    // The fallback exists for 5xx/429 bursts. After a timeout it would discard the
    // SSE chunks that were keeping the transport alive and double the total wait.
    mockMessages.stream.mockImplementation(() => failingStream(
      new APIConnectionTimeoutError({ message: "timed out" })
    ));
    mockMessages.create.mockResolvedValue(okMessage());
    const adapter = new AnthropicAdapter("sk-test");

    const call = adapter.createChatCompletion(
      { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], max_tokens: 64_000 },
      { onToolArgumentsDelta: () => {} }
    );
    await expect(settleWithFakeTimers(call.then(() => "resolved", () => "rejected")))
      .resolves.toBe("rejected");

    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it("a connection failure still DOES fall back, so the recovery path is intact", async () => {
    mockMessages.stream.mockImplementation(() => failingStream(
      new APIConnectionError({ message: "socket hang up" })
    ));
    mockMessages.create.mockResolvedValue(okMessage());
    const adapter = new AnthropicAdapter("sk-test");

    const result = await settleWithFakeTimers(adapter.createChatCompletion(
      { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], max_tokens: 1_000 },
      { onToolArgumentsDelta: () => {} }
    ));

    expect(mockMessages.create).toHaveBeenCalled();
    expect(result.choices[0]?.message.content).toBe("ok");
  });
});

describe("isTimeoutError", () => {
  it("recognises a timeout directly and through an UpstreamUnavailableError wrapper", () => {
    const timeout = new APIConnectionTimeoutError({ message: "timed out" });
    expect(isTimeoutError(timeout)).toBe(true);
    expect(isTimeoutError(new UpstreamUnavailableError(timeout))).toBe(true);
  });

  it("does not treat other connection failures as timeouts", () => {
    const conn = new APIConnectionError({ message: "socket hang up" });
    expect(isTimeoutError(conn)).toBe(false);
    expect(isTimeoutError(new UpstreamUnavailableError(conn))).toBe(false);
    expect(isTimeoutError(new Error("nope"))).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});

describe("effort reaches every entry point, including the pure-streaming one", () => {
  // createChatCompletionStream omitted effort while the other two passed it, so
  // thinking config silently disappeared on that path. Asserted against the object
  // the SDK actually received, not a helper's return value — the same way the
  // disabled-thinking tests work.
  const request = {
    model: "claude-opus-4-8",
    messages: [{ role: "user" as const, content: "hi" }],
    max_tokens: 1_000,
    stream: true as const,
  };

  it("createChatCompletionStream sends thinking + output_config when effort is set", async () => {
    mockMessages.stream.mockReturnValue({
      [Symbol.asyncIterator]() {
        return { async next(): Promise<IteratorResult<unknown>> { return { done: true, value: undefined }; } };
      },
    });
    const adapter = new AnthropicAdapter("sk-test");

    await adapter.createChatCompletionStream(request, { effort: "high" });

    const [body] = mockMessages.stream.mock.calls[0] as [Record<string, unknown>];
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("omits thinking when no effort is configured, rather than inventing one", async () => {
    mockMessages.stream.mockReturnValue({
      [Symbol.asyncIterator]() {
        return { async next(): Promise<IteratorResult<unknown>> { return { done: true, value: undefined }; } };
      },
    });
    const adapter = new AnthropicAdapter("sk-test");

    await adapter.createChatCompletionStream(request, {});

    const [body] = mockMessages.stream.mock.calls[0] as [Record<string, unknown>];
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it("all three entry points agree on the request shape for the same effort", async () => {
    // The asymmetry this fixes: same params, same effort, three entry points, one
    // of which used to drop the thinking config.
    mockMessages.create.mockResolvedValue(okMessage());
    mockMessages.stream.mockReturnValue({
      [Symbol.asyncIterator]() {
        return { async next(): Promise<IteratorResult<unknown>> { return { done: true, value: undefined }; } };
      },
      finalMessage: async () => okMessage(),
    });
    const adapter = new AnthropicAdapter("sk-test");
    const base = { model: "claude-opus-4-8", messages: [{ role: "user" as const, content: "hi" }], max_tokens: 1_000 };

    await adapter.createChatCompletion(base, { effort: "high" });
    await adapter.createChatCompletionStream({ ...base, stream: true }, { effort: "high" });

    const nonStreaming = (mockMessages.create.mock.calls[0] as [Record<string, unknown>])[0];
    const streaming = (mockMessages.stream.mock.calls[0] as [Record<string, unknown>])[0];
    expect(streaming.thinking).toEqual(nonStreaming.thinking);
    expect(streaming.output_config).toEqual(nonStreaming.output_config);
  });
});
