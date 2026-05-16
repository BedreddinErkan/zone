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
});
