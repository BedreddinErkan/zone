import { describe, expect, it, vi, afterEach } from "vitest";
import {
  APIError as AnthropicAPIError,
  APIConnectionError as AnthropicConnectionError,
  APIUserAbortError as AnthropicUserAbortError,
} from "@anthropic-ai/sdk";
import {
  APIError as OpenAIAPIError,
} from "openai";
import {
  classifyError,
  withExponentialBackoff,
  UpstreamUnavailableError,
} from "./withExponentialBackoff.js";
import { ProviderRequestError } from "./factory.js";

afterEach(() => {
  vi.useRealTimers();
});

// -- classifyError --

describe("classifyError", () => {
  it("non-Error value → non_retryable", () => {
    const r = classifyError("something went wrong");
    expect(r.retryable).toBe(false);
    expect(r.retryClass).toBe("non_retryable");
  });

  it("generic Error → non_retryable", () => {
    const r = classifyError(new Error("generic"));
    expect(r.retryable).toBe(false);
    expect(r.retryClass).toBe("non_retryable");
  });

  it("AnthropicUserAbortError → non_retryable", () => {
    const r = classifyError(new AnthropicUserAbortError());
    expect(r.retryable).toBe(false);
    expect(r.retryClass).toBe("non_retryable");
  });

  it("Anthropic RateLimitError (429) → retryable '429'", () => {
    const err = AnthropicAPIError.generate(429, {}, "rate limited", new Headers());
    const r = classifyError(err);
    expect(r.retryable).toBe(true);
    expect(r.retryClass).toBe("429");
  });

  it("Anthropic InternalServerError (500) → retryable '5xx'", () => {
    const err = AnthropicAPIError.generate(500, {}, "server error", new Headers());
    const r = classifyError(err);
    expect(r.retryable).toBe(true);
    expect(r.retryClass).toBe("5xx");
  });

  it("AnthropicConnectionError → retryable 'network'", () => {
    const err = new AnthropicConnectionError({ message: "network failure" });
    const r = classifyError(err);
    expect(r.retryable).toBe(true);
    expect(r.retryClass).toBe("network");
  });

  it("OpenAI RateLimitError (429) → retryable '429'", () => {
    const err = OpenAIAPIError.generate(429, {}, "rate limited", new Headers());
    const r = classifyError(err);
    expect(r.retryable).toBe(true);
    expect(r.retryClass).toBe("429");
  });

  it("OpenAI InternalServerError (500) → retryable '5xx'", () => {
    const err = OpenAIAPIError.generate(500, {}, "server error", new Headers());
    const r = classifyError(err);
    expect(r.retryable).toBe(true);
    expect(r.retryClass).toBe("5xx");
  });

  it("ProviderRequestError → non_retryable (belt-and-suspenders)", () => {
    const err = new ProviderRequestError(400, "retention", "retention message", {});
    const r = classifyError(err);
    expect(r.retryable).toBe(false);
    expect(r.retryClass).toBe("non_retryable");
  });

  it("Anthropic RateLimitError (429) still retryable after adding ProviderRequestError guard", () => {
    const err = AnthropicAPIError.generate(429, {}, "rate limited", new Headers());
    const r = classifyError(err);
    expect(r.retryable).toBe(true);
    expect(r.retryClass).toBe("429");
  });
});

// -- withExponentialBackoff --

describe("withExponentialBackoff", () => {
  it("resolves immediately when fn succeeds on first try", async () => {
    const fn = () => Promise.resolve("ok");
    expect(await withExponentialBackoff(fn, {})).toBe("ok");
  });

  it("retries on 5xx and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const serverErr = AnthropicAPIError.generate(500, {}, "err", new Headers());
    const fn = () => {
      calls++;
      if (calls === 1) return Promise.reject(serverErr);
      return Promise.resolve("recovered");
    };
    const p = withExponentialBackoff(fn, { provider: "anthropic", model: "test-model" });
    await vi.runAllTimersAsync();
    expect(await p).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("throws UpstreamUnavailableError after maxAttempts exhausted (5xx)", async () => {
    vi.useFakeTimers();
    const serverErr = AnthropicAPIError.generate(500, {}, "err", new Headers());
    const fn = () => Promise.reject(serverErr);
    const p = withExponentialBackoff(fn, {});
    // attach rejection handler BEFORE running timers so the rejection is never unhandled
    const assertion = expect(p).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("non-retryable error propagates immediately without retry", async () => {
    const authErr = AnthropicAPIError.generate(401, {}, "unauthorized", new Headers());
    let calls = 0;
    const fn = () => { calls++; return Promise.reject(authErr); };
    await expect(withExponentialBackoff(fn, {})).rejects.toBe(authErr);
    expect(calls).toBe(1);
  });

  // Y.1.6.3 — llm_retry_in_progress narration threshold tests.
  // Math.random is stubbed to 0.5 → jitter term = (0.5*2-1)*jitterPct*delay = 0.
  // 5xx delays: D0=1000, D1=3000, D2=9000 (1000 * 3^attempt).
  // Pending totals: D0→1000, D0+D1→4000, D0+D1+D2→13000. Threshold = 5000.

  it("Y.1.6.3: does not emit llm_retry_in_progress when total wait stays below 5s (2 retries)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const serverErr = AnthropicAPIError.generate(500, {}, "err", new Headers());
    let calls = 0;
    // fn fails twice then succeeds — totalWaited = D0+D1 = 4000 ≤ 5000
    const fn = () => {
      calls++;
      if (calls <= 2) return Promise.reject(serverErr);
      return Promise.resolve("ok");
    };
    const emit = vi.fn();
    const p = withExponentialBackoff(fn, { provider: "anthropic", model: "m", emit });
    await vi.runAllTimersAsync();
    expect(await p).toBe("ok");
    expect(emit).not.toHaveBeenCalledWith("llm_retry_in_progress", expect.anything());
  });

  it("Y.1.6.3: emits llm_retry_in_progress exactly once when total wait crosses 5s (3rd sleep)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const serverErr = AnthropicAPIError.generate(500, {}, "err", new Headers());
    // fn always fails → 3 sleeps (D0=1000, D1=3000, D2=9000), then UpstreamUnavailableError.
    // pendingTotal before D2 = 4000+9000 = 13000 > 5000 → emit fires once.
    const fn = () => Promise.reject(serverErr);
    const emit = vi.fn();
    const p = withExponentialBackoff(fn, { runId: "run-x", provider: "anthropic", model: "m", emit });
    const assertion = expect(p).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await vi.runAllTimersAsync();
    await assertion;
    const narrationCalls = emit.mock.calls.filter(([evt]) => evt === "llm_retry_in_progress");
    expect(narrationCalls).toHaveLength(1);
    const [, payload] = narrationCalls[0]!;
    expect(payload).toMatchObject({
      runId: "run-x",
      provider: "anthropic",
      errorClass: "5xx",
    });
    expect(typeof payload.totalWaitedMs).toBe("number");
    expect(payload.totalWaitedMs as number).toBeGreaterThan(5000);
  });

  it("Y.1.6.3: emits llm_retry_in_progress exactly once even when multiple subsequent sleeps would also cross (5xx exhausted)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const serverErr = AnthropicAPIError.generate(500, {}, "err", new Headers());
    const fn = () => Promise.reject(serverErr);
    const emit = vi.fn();
    const p = withExponentialBackoff(fn, { provider: "anthropic", model: "m", emit });
    const assertion = expect(p).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await vi.runAllTimersAsync();
    await assertion;
    // Only one llm_retry_in_progress regardless of how many sleeps crossed threshold
    expect(
      emit.mock.calls.filter(([evt]) => evt === "llm_retry_in_progress")
    ).toHaveLength(1);
  });
});

describe("UI.3.c: zone_llm_retry_attempt per-attempt event", () => {
  it("emits zone_llm_retry_attempt on each retry attempt with attemptIndex, errorClass, and delayMs", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const serverErr = AnthropicAPIError.generate(500, {}, "err", new Headers());
    let callCount = 0;
    const fn = () => {
      callCount++;
      if (callCount < 3) return Promise.reject(serverErr);
      return Promise.resolve("ok");
    };
    const emit = vi.fn();
    const p = withExponentialBackoff(fn, { runId: "run-y", provider: "anthropic", model: "m", emit });
    const assertion = expect(p).resolves.toBe("ok");
    await vi.runAllTimersAsync();
    await assertion;
    const attemptCalls = emit.mock.calls.filter(([evt]) => evt === "zone_llm_retry_attempt");
    expect(attemptCalls).toHaveLength(2);
    const [, p1] = attemptCalls[0]!;
    expect(p1).toMatchObject({ runId: "run-y", provider: "anthropic", errorClass: "5xx", attemptIndex: 1 });
    expect(typeof (p1 as Record<string, unknown>).delayMs).toBe("number");
    const [, p2] = attemptCalls[1]!;
    expect((p2 as Record<string, unknown>).attemptIndex).toBe(2);
  });

  it("zone_llm_retry_attempt fires independently from Y.1.6.3 llm_retry_in_progress threshold", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const serverErr = AnthropicAPIError.generate(500, {}, "err", new Headers());
    const fn = () => Promise.reject(serverErr);
    const emit = vi.fn();
    const p = withExponentialBackoff(fn, { provider: "anthropic", model: "m", emit });
    const assertion = expect(p).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await vi.runAllTimersAsync();
    await assertion;
    // zone_llm_retry_attempt fires for every attempt; llm_retry_in_progress fires only once (Y.1.6.3)
    const attemptCalls = emit.mock.calls.filter(([evt]) => evt === "zone_llm_retry_attempt");
    const narrationCalls = emit.mock.calls.filter(([evt]) => evt === "llm_retry_in_progress");
    expect(attemptCalls.length).toBeGreaterThan(1); // one per retry attempt
    expect(narrationCalls).toHaveLength(1);          // Y.1.6.3 unchanged
  });
});
