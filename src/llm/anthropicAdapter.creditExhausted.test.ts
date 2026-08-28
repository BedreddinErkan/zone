/**
 * item 413 — direct Anthropic signals credit exhaustion as HTTP 402 `billing_error`, not the
 * gateway-normalized 400 `invalid_request_error` the mapping was originally built against.
 *
 * TWO SHAPES, ONE DISCRIMINATOR. Measured by constructing both through the SDK's own constructors
 * rather than assumed:
 *
 *   402 (pre-generation)  -> APIError, status 402,       type "billing_error"
 *   mid-stream SSE error  -> APIError, status undefined, type "billing_error"
 *
 * The second is what `core/streaming.ts` builds for an `event: error` frame —
 * `new APIError(undefined, body, undefined, headers, type)` — deliberately with no status, since
 * there is no HTTP status to attach to a frame arriving inside a 200 response. So a check keyed on
 * `status === 402` would silently miss it; keying on `type` covers both. Anthropic TYPES this field
 * (`readonly type: ErrorType | null`, with 'billing_error' a union member), unlike OpenAI's bare
 * `string` code/type — so this rests on the SDK's type contract, not documentation alone.
 *
 * WHERE THE STREAMING 402 ACTUALLY THROWS, since these fixtures encode it: `messages.stream()`
 * returns its runner SYNCHRONOUSLY and issues the request fire-and-forget, so the 402 surfaces at
 * the first `for await` iteration — which is exactly what `failingStream` reproduces. It is caught
 * by `createChatCompletion`'s own try/catch, whose `try` opens ABOVE the streaming branch (the
 * `return await` there carries a comment saying why). The streaming path was never unmapped.
 *
 * NOT LIVE-CONFIRMED: both provider balances were exhausted when this was written, so the error
 * shapes here are constructed, and the claim that a real out-of-balance account sends
 * `type: "billing_error"` rests on Anthropic's docs plus its typed enum. `[zone-anthropic-credit-error]`
 * exists to record the real shape the first time a funded account hits it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { APIError as AnthropicAPIError } from "@anthropic-ai/sdk";
import { AnthropicAdapter, mapAnthropicBadRequest } from "./anthropicAdapter.js";
import { ProviderRequestError } from "./factory.js";

// ── Hoisted SDK mock (same shape as anthropicAdapter.streamRetry.test.ts) ─────

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CREDIT_BODY = {
  type: "error",
  error: { type: "billing_error", message: "Your credit balance is too low to access the Anthropic API." },
};

/** Direct Anthropic, pre-generation: HTTP 402. */
function makeBilling402() {
  return AnthropicAPIError.generate(402, CREDIT_BODY, "402 Payment Required", new Headers());
}

/** Mid-stream SSE `event: error` — exactly how core/streaming.ts constructs it (no status). */
function makeMidStreamBillingError() {
  return new AnthropicAPIError(undefined, CREDIT_BODY, undefined, new Headers(), "billing_error");
}

/** The LiteLLM-gateway presentation the mapping was originally built for. */
function makeGateway400() {
  return AnthropicAPIError.generate(
    400,
    { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } },
    "400 Bad Request",
    new Headers(),
  );
}

/** An async iterable that throws `err` on the first iteration — the real streaming mechanism. */
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

const STREAMING_OPTS = { onTextDelta: vi.fn() };
const BASE_PARAMS = {
  model: "claude-opus-4-8",
  messages: [{ role: "user" as const, content: "hi" }],
  max_tokens: 256,
};

function makeAdapter() {
  return new AnthropicAdapter("sk-test");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The two required end-to-end cases ────────────────────────────────────────

describe("Anthropic credit exhaustion (402) reaches the caller as ProviderRequestError", () => {
  it("1. STREAMING path: a 402 during the stream maps to kind:'credit'", async () => {
    mockMessages.stream.mockReturnValueOnce(failingStream(makeBilling402()));

    const adapter = makeAdapter();
    const promise = adapter.createChatCompletion(BASE_PARAMS, STREAMING_OPTS);
    promise.catch(() => {}); // prevent unhandled-rejection before .rejects resolves
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(ProviderRequestError);
    const err = (await promise.catch((e) => e)) as ProviderRequestError;
    expect(err.kind).toBe("credit");
    expect(err.status).toBe(402);
    expect(err.userMessage).toContain("credit balance");
    // 402 is non-retryable, so no retry and no non-streaming fallback.
    expect(mockMessages.stream).toHaveBeenCalledTimes(1);
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it("2. NON-STREAMING path: a 402 maps to kind:'credit'", async () => {
    mockMessages.create.mockRejectedValueOnce(makeBilling402());

    const adapter = makeAdapter();
    const promise = adapter.createChatCompletion(BASE_PARAMS, {}); // no callbacks
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(ProviderRequestError);
    const err = (await promise.catch((e) => e)) as ProviderRequestError;
    expect(err.kind).toBe("credit");
    expect(err.status).toBe(402);
    expect(mockMessages.create).toHaveBeenCalledTimes(1);
  });
});

// ── The shape establish-work surfaced, and the regressions ───────────────────

describe("mapAnthropicBadRequest — widened guard", () => {
  it("3. mid-stream billing_error (no status) maps, reported as 402", () => {
    // The case a status-keyed check would have missed entirely.
    const err = makeMidStreamBillingError();
    expect(err.status).toBeUndefined();
    expect(() => mapAnthropicBadRequest(err)).toThrowError(ProviderRequestError);
    try {
      mapAnthropicBadRequest(err);
    } catch (e) {
      const pr = e as ProviderRequestError;
      expect(pr.kind).toBe("credit");
      expect(pr.status).toBe(402);
    }
  });

  it("4. regression: the LiteLLM 400 presentation still maps to kind:'credit' at status 400", () => {
    try {
      mapAnthropicBadRequest(makeGateway400());
    } catch (e) {
      const pr = e as ProviderRequestError;
      expect(pr.kind).toBe("credit");
      expect(pr.status).toBe(400);
      // Both presentations must say the same thing — one shared message constant.
      expect(pr.userMessage).toContain("Top up");
      expect(pr.userMessage).toContain("Plans & Billing");
    }
  });

  it("5. regression: a 429 and a generic Error still pass through the widened guard unwrapped", () => {
    const rateLimit = AnthropicAPIError.generate(429, {}, "rate limited", new Headers());
    expect(() => mapAnthropicBadRequest(rateLimit)).toThrow(rateLimit);
    try { mapAnthropicBadRequest(rateLimit); } catch (e) {
      expect(e).not.toBeInstanceOf(ProviderRequestError);
    }

    const generic = new Error("something else");
    expect(() => mapAnthropicBadRequest(generic)).toThrow(generic);
  });

  it("6. a non-billing 402 is NOT claimed by the credit branch — the guard is type-keyed, not status-keyed", () => {
    // Guards against over-matching: status alone must not be sufficient.
    const other402 = AnthropicAPIError.generate(
      402,
      { type: "error", error: { type: "invalid_request_error", message: "something else entirely" } },
      "402",
      new Headers(),
    );
    try {
      mapAnthropicBadRequest(other402);
      throw new Error("should have thrown");
    } catch (e) {
      // Falls through the credit branch AND the 400 branch → rethrown as-is.
      expect(e).toBe(other402);
    }
  });
});

describe("[zone-anthropic-credit-error] marker", () => {
  it("7. records the shape that was hit, so a funded account's real response is captured", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try { mapAnthropicBadRequest(makeBilling402()); } catch { /* expected */ }

    const call = spy.mock.calls.find((c) => String(c[0]).includes("zone-anthropic-credit-error"));
    expect(call, "the marker exists to convert a documentation-based claim into an observation").toBeDefined();
    const payload = JSON.parse(String(call![1])) as Record<string, unknown>;
    expect(payload["status"]).toBe(402);
    expect(payload["type"]).toBe("billing_error");
    spy.mockRestore();
  });
});
