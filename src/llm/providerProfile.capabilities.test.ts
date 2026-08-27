import { describe, expect, it, vi } from "vitest";
import { convertParams } from "./anthropicAdapter/convertParams.js";
import { responsesConvertParams } from "./openaiAdapter/responsesConvertParams.js";
import { capabilitiesFor, type ProviderProfile } from "./providerProfile.js";
import {
  DEFAULT_CACHE_MIN_CHARS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  getContextWindow,
  DEFAULT_CONTEXT_WINDOW,
} from "./models.js";

/**
 * Step 4's capability overrides, asserted on the OUTGOING REQUEST BODY rather than on a helper's
 * return value.
 *
 * The distinction is the whole point of this file. A capability that is threaded but never changes
 * a request is indistinguishable from an unconsumed field, and the pre-existing convertParams tests
 * cannot tell the difference because every one of them passes no capabilities — they establish that
 * the old path still works, not that the new one does anything. So each case below builds a profile
 * whose model id appears in NO global table (a leading gateway prefix defeats every prefix lookup,
 * since `startsWith` is anchored at index 0), sets one override, and asserts the field that
 * actually goes on the wire.
 *
 * Two of the six capabilities are deliberately not asserted here, and the reason is recorded rather
 * than left as an omission:
 *   - `contextWindow` never appears in a request body at all — it gates compaction. It is asserted
 *     through its own accessor at the bottom of this file.
 *   - `supportsVision` has no consumer outside the TUI composer, which has no profile in scope. It
 *     is declared and deliberately unconsumed; see ledger item 394 for why the global default
 *     cannot be corrected without that same TUI change.
 */

/** An id no global table can match: the gateway prefix defeats exact and longest-prefix alike. */
const GATEWAY_MODEL = "hub/anthropic/claude-sonnet-4-6";

function gatewayProfile(caps: NonNullable<ProviderProfile["capabilities"]>): ProviderProfile {
  return {
    id: "test-gateway",
    protocol: "openai-chat",
    adapterProvider: "openai",
    keyRef: { envVar: "TEST_GATEWAY_KEY", keyExample: "sk-…" },
    capabilities: caps,
  };
}

function anthropicInput(model: string, systemText: string) {
  return {
    model,
    messages: [
      { role: "system" as const, content: systemText },
      { role: "user" as const, content: "hi" },
    ],
  };
}

describe("maxOutputTokens override reaches the request body", () => {
  it("without an override, an unlisted gateway id gets the conservative default", () => {
    const { params } = convertParams(anthropicInput(GATEWAY_MODEL, "sys"), {});
    expect(params.max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("with an override, max_tokens on the wire is the profile's number", () => {
    const caps = capabilitiesFor(
      gatewayProfile({ models: { [GATEWAY_MODEL]: { maxOutputTokens: 64_000 } } }),
      GATEWAY_MODEL
    );
    const { params } = convertParams(anthropicInput(GATEWAY_MODEL, "sys"), { capabilities: caps });
    expect(params.max_tokens).toBe(64_000);
    expect(params.max_tokens).not.toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("the override also supplies the ceiling clamp an unlisted id otherwise never gets", () => {
    // lookupMaxOutputTokens returning undefined for an unlisted id means NO clamp is applied — a
    // caller asking for more than the endpoint allows sails through to a 400. A declared ceiling
    // restores the clamp, so an over-ask is cut down to the declared maximum.
    const caps = capabilitiesFor(
      gatewayProfile({ default: { maxOutputTokens: 8_000 } }),
      GATEWAY_MODEL
    );
    const { params } = convertParams(
      { ...anthropicInput(GATEWAY_MODEL, "sys"), max_tokens: 100_000 },
      { capabilities: caps }
    );
    expect(params.max_tokens).toBe(8_000);
  });
});

describe("cacheMinChars override reaches the request body", () => {
  /** Under the 8200-char default, over a declared 2048 minimum. */
  const MID_SIZED = "x".repeat(4_000);

  function systemIsCached(params: { system?: unknown }): boolean {
    const system = params.system;
    if (!Array.isArray(system)) return false;
    return system.some(
      (block) => (block as { cache_control?: unknown }).cache_control !== undefined
    );
  }

  it("without an override, a mid-sized prompt on an unlisted id is NOT cached", () => {
    const { params } = convertParams(anthropicInput(GATEWAY_MODEL, MID_SIZED), {});
    expect(systemIsCached(params)).toBe(false);
  });

  it("with a lower declared minimum, the same prompt carries cache_control", () => {
    const caps = capabilitiesFor(
      gatewayProfile({ default: { cacheMinChars: 2_048 } }),
      GATEWAY_MODEL
    );
    expect(caps?.cacheMinChars).toBeLessThan(DEFAULT_CACHE_MIN_CHARS);
    const { params } = convertParams(anthropicInput(GATEWAY_MODEL, MID_SIZED), {
      capabilities: caps,
    });
    expect(systemIsCached(params)).toBe(true);
  });
});

describe("effortLevels override reaches the request body", () => {
  it("without an override, effort on an unlisted id is dropped — no thinking block", () => {
    const { params } = convertParams(anthropicInput(GATEWAY_MODEL, "sys"), { effort: "high" });
    expect((params as { thinking?: unknown }).thinking).toBeUndefined();
  });

  it("a declared ladder makes the requested effort take effect on the wire", () => {
    const caps = capabilitiesFor(
      gatewayProfile({ default: { effortLevels: ["low", "medium", "high"] } }),
      GATEWAY_MODEL
    );
    const { params } = convertParams(anthropicInput(GATEWAY_MODEL, "sys"), {
      effort: "high",
      capabilities: caps,
    });
    // This is the case that proves BOTH halves of the effort override are wired. The budget is
    // gated on `resolvedEffort && supportsEffort(model)`, which read two independent sets — had
    // only the ladder been overridden, the effort would resolve and then be silently discarded
    // here, and `thinking` would still be undefined.
    expect((params as { thinking?: { budget_tokens?: number } }).thinking?.budget_tokens)
      .toBeGreaterThan(0);
  });

  it("an explicitly empty ladder means 'no effort', distinct from declaring nothing", () => {
    const caps = capabilitiesFor(
      gatewayProfile({ default: { effortLevels: [] } }),
      GATEWAY_MODEL
    );
    const { params } = convertParams(anthropicInput(GATEWAY_MODEL, "sys"), {
      effort: "high",
      capabilities: caps,
    });
    expect((params as { thinking?: unknown }).thinking).toBeUndefined();
  });

  it("the same override reaches the OpenAI Responses body as reasoning.effort", () => {
    const caps = capabilitiesFor(
      gatewayProfile({ default: { effortLevels: ["low", "medium", "high"] } }),
      GATEWAY_MODEL
    );
    const body = responsesConvertParams(
      { model: GATEWAY_MODEL, messages: [{ role: "user", content: "hi" }] },
      { effort: "high", capabilities: caps }
    );
    expect(body.reasoning).toEqual({ summary: "auto", effort: "high" });
  });

  it("a truncated ladder clamps DOWN and says so rather than dropping silently", () => {
    // The ladder has no level at or below "low", so the effort is dropped rather than clamped up.
    // That branch was unreachable while every global row contained "low"; an override reaches it,
    // and a drop that says nothing is the degradation this layer exists to remove.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const caps = capabilitiesFor(
      gatewayProfile({ default: { effortLevels: ["high", "max"] } }),
      GATEWAY_MODEL
    );
    const body = responsesConvertParams(
      { model: GATEWAY_MODEL, messages: [{ role: "user", content: "hi" }] },
      { effort: "low", capabilities: caps }
    );
    expect(body.reasoning?.effort).toBeUndefined();
    const clamped = warn.mock.calls.find((c) => String(c[0]) === "[zone-effort-clamped]");
    expect(clamped).toBeDefined();
    expect((clamped?.[1] as { resolved?: unknown })?.resolved).toBeNull();
    warn.mockRestore();
  });
});

describe("adaptiveThinking override reaches the request body", () => {
  it("declaring adaptive switches the wire shape from a budget to an effort", () => {
    const caps = capabilitiesFor(
      gatewayProfile({
        default: { adaptiveThinking: true, effortLevels: ["low", "medium", "high"] },
      }),
      GATEWAY_MODEL
    );
    const { params } = convertParams(anthropicInput(GATEWAY_MODEL, "sys"), {
      effort: "high",
      capabilities: caps,
    });
    // Adaptive models carry output_config.effort and NOT an explicit thinking budget.
    expect((params as { output_config?: { effort?: string } }).output_config?.effort).toBe("high");
    expect((params as { thinking?: { budget_tokens?: number } }).thinking?.budget_tokens)
      .toBeUndefined();
  });
});

describe("contextWindow override — not a request-body field, asserted at its accessor", () => {
  it("an unlisted gateway id assumes the conservative default without an override", () => {
    expect(getContextWindow(GATEWAY_MODEL)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("a declared window is used instead, which is what stops premature compaction", () => {
    const caps = capabilitiesFor(
      gatewayProfile({ models: { [GATEWAY_MODEL]: { contextWindow: 1_000_000 } } }),
      GATEWAY_MODEL
    );
    expect(getContextWindow(GATEWAY_MODEL, caps)).toBe(1_000_000);
    // The 5x under-read is the point: compaction triggers at 75% of whichever figure wins.
    expect(getContextWindow(GATEWAY_MODEL, caps)).toBeGreaterThan(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("built-in profiles declare no capabilities, so they resolve exactly as before", () => {
  it("capabilitiesFor returns undefined for both built-ins", async () => {
    const { ANTHROPIC_PROFILE, OPENAI_PROFILE } = await import("./providerProfile.js");
    expect(capabilitiesFor(ANTHROPIC_PROFILE, "claude-sonnet-4-6")).toBeUndefined();
    expect(capabilitiesFor(OPENAI_PROFILE, "gpt-4o")).toBeUndefined();
  });
});
