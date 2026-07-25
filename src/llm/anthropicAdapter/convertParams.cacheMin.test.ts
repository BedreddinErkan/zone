/**
 * Per-model cache minimums.
 *
 * The threshold was a single 8200-char constant carrying a comment about Sonnet 4.x,
 * applied to every model. Opus 5's real minimum is 512 tokens, so prompts between
 * roughly 2k and 8.2k characters were being sent uncached that the API would have
 * cached.
 *
 * NOTE this is a hypothesis about savings, not a measured one: a lower threshold
 * produces cache WRITES immediately and cache READS only if the same prefix recurs
 * inside the TTL. At 1.25x write and 0.1x read a single read repays the premium, but
 * zero reads is a ~25% loss on those tokens. Check cache_read_input_tokens on
 * plan-gen calls after a few real runs before calling it a win.
 */
import { describe, expect, it } from "vitest";
import { convertParams } from "./convertParams.js";
import { getCacheMinChars, DEFAULT_CACHE_MIN_CHARS } from "../models.js";

/** Between Opus 5's 2048-char minimum and the 8200-char default. */
const MID_SIZED_SYSTEM = "x".repeat(4_000);

function inputWith(model: string, systemText: string) {
  return {
    model,
    messages: [
      { role: "system" as const, content: systemText },
      { role: "user" as const, content: "hi" },
    ],
  };
}

function hasCacheControl(params: { system?: unknown }): boolean {
  const system = params.system;
  if (!Array.isArray(system)) return false;
  return system.some((b) => (b as { cache_control?: unknown }).cache_control !== undefined);
}

describe("getCacheMinChars", () => {
  it("claude-opus-5 resolves its own 512-token minimum", () => {
    expect(getCacheMinChars("claude-opus-5")).toBe(2_048);
  });

  it("a non-Opus-5 model resolves 8200 THROUGH the accessor", () => {
    // The pre-existing cache tests copy the 8200 literal, so they only show they
    // didn't break — not that the new resolution path returns the right value for
    // everything else. Pin a specific model, not just the constant.
    expect(getCacheMinChars("claude-sonnet-4-6")).toBe(8_200);
    expect(getCacheMinChars("claude-sonnet-4-6")).toBe(DEFAULT_CACHE_MIN_CHARS);
    expect(getCacheMinChars("claude-haiku-4-5")).toBe(DEFAULT_CACHE_MIN_CHARS);
    expect(getCacheMinChars("gpt-5.6-sol")).toBe(DEFAULT_CACHE_MIN_CHARS);
    expect(getCacheMinChars("some-unlisted-model")).toBe(DEFAULT_CACHE_MIN_CHARS);
  });

  it("a dated snapshot id resolves to its alias", () => {
    expect(getCacheMinChars("claude-opus-5-20260801")).toBe(2_048);
  });
});

describe("convertParams — cache eligibility uses the model's own minimum", () => {
  it("a mid-sized prompt is cacheable on Opus 5", () => {
    const { params } = convertParams(inputWith("claude-opus-5", MID_SIZED_SYSTEM));
    expect(hasCacheControl(params)).toBe(true);
  });

  it("the same prompt is NOT cacheable on a default-threshold model", () => {
    const { params } = convertParams(inputWith("claude-sonnet-4-6", MID_SIZED_SYSTEM));
    expect(hasCacheControl(params)).toBe(false);
  });

  it("a prompt below even Opus 5's minimum stays uncached", () => {
    const { params } = convertParams(inputWith("claude-opus-5", "x".repeat(500)));
    expect(hasCacheControl(params)).toBe(false);
  });

  it("a prompt above the default threshold is cacheable everywhere", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-4-6"]) {
      const { params } = convertParams(inputWith(model, "x".repeat(9_000)));
      expect(hasCacheControl(params), model).toBe(true);
    }
  });
});
