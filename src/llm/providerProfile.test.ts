import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ANTHROPIC_PROFILE,
  capabilitiesFor,
  OPENAI_PROFILE,
  profileForProvider,
  providerOf,
  resolveProfile,
  priceForProfile,
  warnProfileCannotPriceOnce,
  warnBudgetGateInertOnce,
  _resetProviderProfileWarningsForTest,
  type ProviderProfile,
  warnProfilePartialPricingOnce,} from "./providerProfile.js";
import { totalCost } from "../usage/pricing.js";

/**
 * The nine-agent verification behind ledger item 387 found that every one of the ~150 pinned tests
 * across the provider-resolution surface checks the refactor's mechanical fidelity — the same
 * strings, the same numbers, the same call arities — and that NOT ONE exercises its actual purpose.
 * The unknown-pricing branch is unreachable from any of them, because both built-in profiles carry
 * a pricing table. This file is where that branch is exercised, and it is the reason the type-level
 * distinction is a behavioural contract rather than an annotation.
 */

/** A profile with no pricing table — the shape a gateway would have. Not reachable in production
 *  today; that is precisely why it needs a test. */
const UNPRICEABLE: ProviderProfile = {
  id: "test-gateway",
  protocol: "openai-chat",
  adapterProvider: "openai",
  keyRef: { envVar: "TEST_GATEWAY_KEY", keyExample: "sk-…" },
};

const ZERO_CACHE = {
  input_uncached: 100,
  cache_write: 0,
  cache_read: 0,
  output: 30,
} as const;

beforeEach(() => {
  _resetProviderProfileWarningsForTest();
});

describe("resolveProfile — precedence, with the fallback supplied per site", () => {
  it("explicit wins over context", () => {
    const p = resolveProfile({ explicit: "openai", context: "anthropic", fallback: "anthropic" });
    expect(p.id).toBe("openai");
  });

  it("context wins when no explicit is given", () => {
    const p = resolveProfile({ context: "openai", fallback: "anthropic" });
    expect(p.id).toBe("openai");
  });

  it("the site's own fallback is used when neither is given — anthropic sites", () => {
    expect(resolveProfile({ fallback: "anthropic" }).id).toBe("anthropic");
  });

  it("the site's own fallback is used when neither is given — openai sites", () => {
    // The six-and-six split from the investigation's §2.4 is preserved by this argument, not by a
    // constant inside the resolver. If this ever returns "anthropic", the split has been unified
    // by accident rather than by decision.
    expect(resolveProfile({ fallback: "openai" }).id).toBe("openai");
  });

  it("an empty-string explicit is treated as absent, not as unrecognized", () => {
    const onUnrecognized = vi.fn();
    const p = resolveProfile({ explicit: "", fallback: "anthropic", onUnrecognized });
    expect(p.id).toBe("anthropic");
    expect(onUnrecognized).not.toHaveBeenCalled();
  });

  it("an unrecognized explicit falls back AND reports the raw value", () => {
    const onUnrecognized = vi.fn();
    const p = resolveProfile({ explicit: "openrouter", fallback: "anthropic", onUnrecognized });
    expect(p.id).toBe("anthropic");
    expect(onUnrecognized).toHaveBeenCalledWith("openrouter");
  });

  it("an unrecognized explicit falls back to the SITE's fallback, not a global one", () => {
    const p = resolveProfile({ explicit: "openrouter", fallback: "openai" });
    expect(p.id).toBe("openai");
  });

  it("a recognized explicit never reports unrecognized", () => {
    const onUnrecognized = vi.fn();
    resolveProfile({ explicit: "anthropic", fallback: "anthropic", onUnrecognized });
    resolveProfile({ explicit: "openai", fallback: "anthropic", onUnrecognized });
    expect(onUnrecognized).not.toHaveBeenCalled();
  });
});

describe("providerOf / profileForProvider", () => {
  it("round-trips both built-ins", () => {
    expect(providerOf(profileForProvider("anthropic"))).toBe("anthropic");
    expect(providerOf(profileForProvider("openai"))).toBe("openai");
  });

  it("the built-ins' protocol and adapterProvider are the fusion this record exists to split", () => {
    // Today they agree for both built-ins, which is exactly why a wrong reading of either is
    // invisible. Pinned so a future gateway profile whose two fields DISAGREE is a deliberate
    // change to this expectation rather than a silent one.
    expect(ANTHROPIC_PROFILE.protocol).toBe("anthropic-messages");
    expect(ANTHROPIC_PROFILE.adapterProvider).toBe("anthropic");
    expect(OPENAI_PROFILE.protocol).toBe("openai-chat");
    expect(OPENAI_PROFILE.adapterProvider).toBe("openai");
  });

  it("both built-ins name the existing env var and key-store provider — no key-store schema change", () => {
    expect(ANTHROPIC_PROFILE.keyRef.envVar).toBe("ANTHROPIC_API_KEY");
    expect(ANTHROPIC_PROFILE.keyRef.keyStoreProvider).toBe("anthropic");
    expect(OPENAI_PROFILE.keyRef.envVar).toBe("OPENAI_API_KEY");
    expect(OPENAI_PROFILE.keyRef.keyStoreProvider).toBe("openai");
  });
});

describe("priceForProfile — the unknown-vs-zero distinction", () => {
  it("a built-in profile prices exactly as totalCost does, and is marked known", () => {
    const priced = priceForProfile(ANTHROPIC_PROFILE, "claude-haiku-4-5", { ...ZERO_CACHE });
    expect(priced.known).toBe(true);
    // Derived from the real table rather than a hand-typed literal, so this is a routing pin
    // rather than the same arithmetic written twice.
    const expected = totalCost("anthropic", "claude-haiku-4-5", { ...ZERO_CACHE });
    expect(priced.known === true && priced.usd).toBeCloseTo(expected, 12);
  });

  it("each built-in prices against its OWN table, not the other one", () => {
    const a = priceForProfile(ANTHROPIC_PROFILE, "claude-haiku-4-5", { ...ZERO_CACHE });
    const o = priceForProfile(OPENAI_PROFILE, "gpt-4o-mini", { ...ZERO_CACHE });
    expect(a.known === true && a.usd).toBeCloseTo(
      totalCost("anthropic", "claude-haiku-4-5", { ...ZERO_CACHE }), 12);
    expect(o.known === true && o.usd).toBeCloseTo(
      totalCost("openai", "gpt-4o-mini", { ...ZERO_CACHE }), 12);
    // A mis-routed table would price an anthropic-only id as an unknown model in the openai
    // table -> $0, so the two figures differing is what proves the routing, not the rates.
    expect(a.known === true && a.usd).not.toBeCloseTo(o.known === true ? o.usd : -1, 12);
  });

  it("A PROFILE WITH NO PRICING RETURNS unknown, NOT ZERO — the branch no pinned test can reach", () => {
    const priced = priceForProfile(UNPRICEABLE, "some-gateway-model", { ...ZERO_CACHE });
    expect(priced.known).toBe(false);
    expect(priced.known === false && priced.reason).toBe("no_pricing_for_profile");
    // Explicitly NOT a number: the whole point is that this is distinguishable from $0.
    expect(priced).not.toHaveProperty("usd");
  });

  it("unknown does not depend on the model id — it is a property of the profile", () => {
    // Even a model that IS in the openai table prices as unknown under a profile with no table,
    // which is what separates this from totalCost's own unknown-model $0 (item 299's concern).
    const priced = priceForProfile(UNPRICEABLE, "gpt-4o-mini", { ...ZERO_CACHE });
    expect(priced.known).toBe(false);
  });
});

describe("warn-once helpers", () => {
  it("warns once per profile that cannot price, not once per call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnProfileCannotPriceOnce(UNPRICEABLE);
    warnProfileCannotPriceOnce(UNPRICEABLE);
    warnProfileCannotPriceOnce(UNPRICEABLE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("[zone-profile-no-pricing]");
    expect(String(warn.mock.calls[0]?.[0])).toContain("test-gateway");
    warn.mockRestore();
  });

  it("stays silent for a profile that can price", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnProfileCannotPriceOnce(ANTHROPIC_PROFILE);
    warnProfileCannotPriceOnce(OPENAI_PROFILE);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("the budget-gate warning is separate, fires once, and names the cap", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnBudgetGateInertOnce(UNPRICEABLE, 2.5);
    warnBudgetGateInertOnce(UNPRICEABLE, 2.5);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("[zone-budget-gate-inert]");
    expect(String(warn.mock.calls[0]?.[0])).toContain("$2.50");
    warn.mockRestore();
  });

  it("the budget-gate warning stays silent for a profile that can price", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnBudgetGateInertOnce(ANTHROPIC_PROFILE, 2.5);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("the two warnings are independent — one firing does not suppress the other", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnProfileCannotPriceOnce(UNPRICEABLE);
    warnBudgetGateInertOnce(UNPRICEABLE, 1);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("_resetProviderProfileWarningsForTest re-arms both, so the dedupe cannot silently persist", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnProfileCannotPriceOnce(UNPRICEABLE);
    warnBudgetGateInertOnce(UNPRICEABLE, 1);
    _resetProviderProfileWarningsForTest();
    warnProfileCannotPriceOnce(UNPRICEABLE);
    warnBudgetGateInertOnce(UNPRICEABLE, 1);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});

describe("capabilitiesFor — per-model over default, undefined when nothing is declared (item 392)", () => {
  const BARE: ProviderProfile = {
    id: "bare-gateway",
    protocol: "openai-chat",
    adapterProvider: "openai",
    keyRef: { envVar: "X", keyExample: "sk-…" },
  };

  it("a profile declaring no capabilities returns undefined, not an empty object", () => {
    // undefined is the signal every consumer keys on to fall through to the global tables. An
    // empty object would be a declaration that overrides nothing, which is a different thing and
    // would still short-circuit a `caps?.x !== undefined` check the same way — but only by luck.
    expect(capabilitiesFor(BARE, "any-model")).toBeUndefined();
    expect(capabilitiesFor(undefined, "any-model")).toBeUndefined();
  });

  it("a default applies to any model the profile serves", () => {
    const p = { ...BARE, capabilities: { default: { contextWindow: 32_000 } } };
    expect(capabilitiesFor(p, "anything-at-all")?.contextWindow).toBe(32_000);
  });

  it("a per-model entry wins over the default, field by field", () => {
    const p = {
      ...BARE,
      capabilities: {
        default: { contextWindow: 32_000, maxOutputTokens: 4_096 },
        models: { "special/model": { maxOutputTokens: 64_000 } },
      },
    };
    const caps = capabilitiesFor(p, "special/model");
    // The per-model entry overrode only maxOutputTokens; contextWindow still comes from default.
    expect(caps?.maxOutputTokens).toBe(64_000);
    expect(caps?.contextWindow).toBe(32_000);
    // A model with no entry is unaffected by the override.
    expect(capabilitiesFor(p, "other/model")?.maxOutputTokens).toBe(4_096);
  });

  it("matching is EXACT on the id as given — no normalization, no prefix walk", () => {
    const p = { ...BARE, capabilities: { models: { "hub/m": { contextWindow: 1 } } } };
    expect(capabilitiesFor(p, "hub/m")?.contextWindow).toBe(1);
    // Deliberately not matched: a third resolution strategy that guessed would disagree with both
    // existing ones, which already disagree with each other.
    expect(capabilitiesFor(p, "hub/m-20260219")).toBeUndefined();
    expect(capabilitiesFor(p, "prefix/hub/m")).toBeUndefined();
  });

  it("neither built-in declares capabilities, which is what keeps their resolution unchanged", () => {
    expect(ANTHROPIC_PROFILE.capabilities).toBeUndefined();
    expect(OPENAI_PROFILE.capabilities).toBeUndefined();
  });
});

describe("priceForProfile — inline rates are consulted before the named table (item 392)", () => {
  const RATES = { input: 1, output: 2, cache_read: 0, cache_write: 0 };

  it("inline rates price a model no global table knows", () => {
    const p: ProviderProfile = {
      id: "rate-gateway",
      protocol: "openai-chat",
      adapterProvider: "openai",
      keyRef: { envVar: "X", keyExample: "sk-…" },
      pricing: { rates: { "hub/some-model": RATES } },
    };
    const priced = priceForProfile(p, "hub/some-model", { ...ZERO_CACHE });
    expect(priced.known).toBe(true);
    // 100 input @ $1/MTok + 30 output @ $2/MTok
    expect(priced.known === true && priced.usd).toBeCloseTo(100 / 1e6 + (30 * 2) / 1e6, 12);
  });

  it("inline rates win over the named table for the same model id", () => {
    const p: ProviderProfile = {
      ...OPENAI_PROFILE,
      id: "override-gateway",
      pricing: { table: "openai", rates: { "gpt-4o-mini": RATES } },
    };
    const viaInline = priceForProfile(p, "gpt-4o-mini", { ...ZERO_CACHE });
    const viaTable = priceForProfile(OPENAI_PROFILE, "gpt-4o-mini", { ...ZERO_CACHE });
    expect(viaInline.known === true && viaInline.usd).toBeCloseTo(100 / 1e6 + 60 / 1e6, 12);
    // Different figures prove the inline table was consulted rather than skipped.
    expect(viaInline.known === true && viaInline.usd)
      .not.toBeCloseTo(viaTable.known === true ? viaTable.usd : -1, 12);
  });

  it("a model absent from the inline rates falls through to the named table", () => {
    const p: ProviderProfile = {
      ...OPENAI_PROFILE,
      id: "partial-gateway",
      pricing: { table: "openai", rates: { "hub/other": RATES } },
    };
    const priced = priceForProfile(p, "gpt-4o-mini", { ...ZERO_CACHE });
    const viaTable = priceForProfile(OPENAI_PROFILE, "gpt-4o-mini", { ...ZERO_CACHE });
    expect(priced.known === true && priced.usd)
      .toBeCloseTo(viaTable.known === true ? viaTable.usd : -1, 12);
  });

  it("a pricing block that answers for nothing is still UNKNOWN, not zero", () => {
    const p: ProviderProfile = {
      id: "empty-pricing",
      protocol: "openai-chat",
      adapterProvider: "openai",
      keyRef: { envVar: "X", keyExample: "sk-…" },
      pricing: { rates: { "hub/other": RATES } },
    };
    const priced = priceForProfile(p, "hub/unlisted", { ...ZERO_CACHE });
    expect(priced.known).toBe(false);
    expect(priced).not.toHaveProperty("usd");
  });
});

describe("warnProfilePartialPricingOnce — a skipped zero is not a declared zero (item 399)", () => {
  const PARTIAL = {
    id: "lab-partial",
    protocol: "openai-chat" as const,
    adapterProvider: "openai" as const,
    keyRef: { envVar: "ZONE_GATEWAY_KEY_LAB", keyExample: "x" },
    pricing: {
      rates: { m: { input: 1, output: 2, cache_read: 0, cache_write: 0 } },
      cacheUnpricedModels: ["m"],
    },
  };

  beforeEach(() => { _resetProviderProfileWarningsForTest(); });

  it("names the models and says the zero is an omission, not a statement about the endpoint", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnProfilePartialPricingOnce(PARTIAL);
    const line = String(warn.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("[zone-profile-partial-pricing]");
    expect(line).toContain("lab-partial");
    expect(line).toContain("m");
    expect(line).toMatch(/SKIPPED/);
    expect(line).toMatch(/floor, not a total/);
    warn.mockRestore();
  });

  it("fires once per profile", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnProfilePartialPricingOnce(PARTIAL);
    warnProfilePartialPricingOnce(PARTIAL);
    expect(warn.mock.calls.filter(c => String(c[0]).includes("partial-pricing"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("stays silent when every bucket was declared — including declared zeros", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { cacheUnpricedModels: _drop, ...rates } = PARTIAL.pricing;
    warnProfilePartialPricingOnce({ ...PARTIAL, pricing: rates });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stays silent for both built-ins", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnProfilePartialPricingOnce(ANTHROPIC_PROFILE);
    warnProfilePartialPricingOnce(OPENAI_PROFILE);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
