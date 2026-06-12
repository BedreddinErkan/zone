import { describe, it, expect } from "vitest";
import { APIError as AnthropicAPIError, RateLimitError } from "@anthropic-ai/sdk";
import { mapAnthropicBadRequest } from "./anthropicAdapter.js";
import { ProviderRequestError } from "./factory.js";

// Build a BadRequestError using the SDK's factory method.
// The second argument is the full parsed HTTP response body — Anthropic sends:
//   {"type":"error","error":{"type":"invalid_request_error","message":"..."}}
// err.error = full body; err.error.error.message = actual message; err.type = inner type (SDK convenience).
function makeBadRequest400(innerType: string, innerMessage: string) {
  return AnthropicAPIError.generate(
    400,
    { type: "error", error: { type: innerType, message: innerMessage } },
    "400 Bad Request",
    new Headers(),
  );
}

describe("mapAnthropicBadRequest — retention classification", () => {
  it("'retention' keyword in message → kind:'retention'", () => {
    const err = makeBadRequest400(
      "invalid_request_error",
      "This model requires 30-day data retention",
    );
    expect(() => mapAnthropicBadRequest(err)).toThrowError(ProviderRequestError);
    try { mapAnthropicBadRequest(err); } catch (e) {
      const pr = e as ProviderRequestError;
      expect(pr.kind).toBe("retention");
      expect(pr.status).toBe(400);
      expect(pr.userMessage).toContain("≥30 days");
    }
  });

  it("'zero data retention' in message → kind:'retention'", () => {
    const err = makeBadRequest400(
      "invalid_request_error",
      "zero data retention not supported for this model",
    );
    try { mapAnthropicBadRequest(err); } catch (e) {
      expect((e as ProviderRequestError).kind).toBe("retention");
    }
  });

  it("'ZDR' in message (case-insensitive) → kind:'retention'", () => {
    const err = makeBadRequest400(
      "invalid_request_error",
      "ZDR accounts cannot use this model",
    );
    try { mapAnthropicBadRequest(err); } catch (e) {
      expect((e as ProviderRequestError).kind).toBe("retention");
    }
  });
});

describe("mapAnthropicBadRequest — non-retention 400 classification", () => {
  it("invalid_request_error without retention keywords → kind:'request_shape'", () => {
    const err = makeBadRequest400(
      "invalid_request_error",
      "model not found in this region",
    );
    try { mapAnthropicBadRequest(err); } catch (e) {
      const pr = e as ProviderRequestError;
      expect(pr.kind).toBe("request_shape");
      expect(pr.status).toBe(400);
    }
  });

  it("other_error type at 400 → kind:'other'", () => {
    const err = makeBadRequest400(
      "other_error_type",
      "unexpected error",
    );
    try { mapAnthropicBadRequest(err); } catch (e) {
      expect((e as ProviderRequestError).kind).toBe("other");
    }
  });
});

describe("mapAnthropicBadRequest — non-400 errors pass through unchanged", () => {
  it("RateLimitError (429) is rethrown as-is (not wrapped in ProviderRequestError)", () => {
    const err = AnthropicAPIError.generate(429, {}, "rate limited", new Headers()) as RateLimitError;
    expect(() => mapAnthropicBadRequest(err)).toThrow(err);
    try { mapAnthropicBadRequest(err); } catch (e) {
      expect(e).not.toBeInstanceOf(ProviderRequestError);
      expect(e).toBe(err);
    }
  });

  it("generic Error is rethrown as-is", () => {
    const err = new Error("something else");
    expect(() => mapAnthropicBadRequest(err)).toThrow(err);
  });
});
