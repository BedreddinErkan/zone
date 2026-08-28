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

  // ── item 411 — a 429 from an exhausted OpenAI quota is not the same as rate limiting ──────────
  //
  // OpenAI returns 429 for both `rate_limit_exceeded` (transient) and quota/billing exhaustion
  // (permanent within the billing period). Confirmed against OpenAI's own current docs, fetched
  // live: `type: "insufficient_quota"` is the documented umbrella for every billing-related 429,
  // and `code` names the specific cause underneath it. Both fields are UNTYPED strings on the SDK's
  // own APIError (`code: string | null | undefined`, `type: string | undefined` —
  // node_modules/openai/src/core/error.ts) — the SDK gives no compile-time guarantee of the
  // specific values, so these fixtures build the exact JSON body shape the SDK's own
  // `APIError.generate` extracts `code`/`type` from, rather than asserting against a typed enum
  // that does not exist.
  it("OpenAI RateLimitError with type=insufficient_quota → non-retryable 'quota_exceeded'", () => {
    const err = OpenAIAPIError.generate(
      429,
      { error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" } },
      "quota exceeded",
      new Headers()
    );
    const r = classifyError(err);
    expect(r.retryable).toBe(false);
    expect(r.retryClass).toBe("quota_exceeded");
  });

  it("OpenAI RateLimitError with a documented spend-limit code (type still insufficient_quota) → non-retryable 'quota_exceeded'", () => {
    const err = OpenAIAPIError.generate(
      429,
      { error: { type: "insufficient_quota", code: "organization_spend_limit_exceeded", message: "spend limit reached" } },
      "spend limit reached",
      new Headers()
    );
    const r = classifyError(err);
    expect(r.retryable).toBe(false);
    expect(r.retryClass).toBe("quota_exceeded");
  });

  it("OpenAI RateLimitError with NO type/code (ordinary rate limiting) → still retryable '429'", () => {
    // Regression guard: the new check must not over-match. OpenAI's own docs show no `code` at
    // all for "Rate limit reached for requests" — this fixture is that shape exactly.
    const err = OpenAIAPIError.generate(
      429,
      { error: { message: "Rate limit reached for requests" } },
      "rate limited",
      new Headers()
    );
    const r = classifyError(err);
    expect(r.retryable).toBe(true);
    expect(r.retryClass).toBe("429");
  });

  it("Anthropic RateLimitError is unaffected by the OpenAI-only quota check", () => {
    // Anthropic's billing exhaustion is a DIFFERENT status (402, billing_error) entirely — not a
    // 429 at all (platform.claude.com/docs/en/api/errors, fetched live). This check is scoped to
    // OpenAI deliberately; an Anthropic 429 must never be reclassified by it.
    const err = AnthropicAPIError.generate(
      429,
      { error: { type: "rate_limit_error", message: "rate limited" } },
      "rate limited",
      new Headers()
    );
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

  it("item 411: a quota-exhausted OpenAI 429 propagates immediately with ZERO retries, not the 4-attempt 429 budget", async () => {
    vi.useFakeTimers();
    const quotaErr = OpenAIAPIError.generate(
      429,
      { error: { type: "insufficient_quota", code: "insufficient_quota", message: "no credit" } },
      "no credit",
      new Headers()
    );
    let calls = 0;
    const fn = () => { calls++; return Promise.reject(quotaErr); };
    const p = withExponentialBackoff(fn, { provider: "openai", model: "gpt-5.5" });
    const assertion = expect(p).rejects.toBe(quotaErr);
    await vi.runAllTimersAsync();
    await assertion;
    // Before the fix this classified as retryable "429" and burned rateLimit429.maxAttempts (4)
    // attempts at 5s/15s/45s delays each — exactly the six-attempt, 4-16s-each pattern item 411
    // measured live. One call, no wait, is the fix.
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
