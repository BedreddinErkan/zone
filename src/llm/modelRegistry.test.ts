import { describe, it, expect } from "vitest";
import { getProviderForModel, supportsEffort, usesAdaptiveThinking, normalizeModelId, effortLevelsFor, resolveEffortForModel } from "./modelRegistry.js";
import { MODEL_CATALOG } from "./models.js";

describe("modelRegistry", () => {
  it("getProviderForModel returns correct provider for known models", () => {
    expect(getProviderForModel("claude-sonnet-4-6")).toBe("anthropic");
    expect(getProviderForModel("claude-opus-4-8")).toBe("anthropic");
    expect(getProviderForModel("claude-opus-4-7")).toBe("anthropic");
    expect(getProviderForModel("gpt-5.4")).toBe("openai");
    expect(getProviderForModel("gpt-5.4-mini")).toBe("openai");
    expect(getProviderForModel("unknown-model")).toBe("anthropic");  // fallback
  });

  it("supportsEffort returns true for supporting models and false for others", () => {
    expect(supportsEffort("claude-opus-5")).toBe(true);
    expect(supportsEffort("claude-sonnet-5")).toBe(true);
    expect(supportsEffort("claude-sonnet-4-6")).toBe(true);
    expect(supportsEffort("claude-opus-4-8")).toBe(true);
    expect(supportsEffort("claude-opus-4-7")).toBe(true);
    expect(supportsEffort("claude-sonnet-4-5")).toBe(true);
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsEffort("gpt-5.4")).toBe(true);
    expect(supportsEffort("gpt-5.4-mini")).toBe(true);
    expect(supportsEffort("gpt-5.5")).toBe(true);
    // Corrected 2026-08-20 from false, on live evidence. nano's exclusion never stated a reason;
    // measured against the real API it accepts reasoning.effort AND reasoning.summary at
    // low/medium/high and returns real summary prose at every one.
    expect(supportsEffort("gpt-5.4-nano")).toBe(true);
    expect(supportsEffort("gpt-4o")).toBe(false);
    expect(supportsEffort("gpt-4o-mini")).toBe(false);
  });

  it("a dated OpenAI id resolves like its base alias — the arm the old copy was missing", () => {
    // Before the normalizer was unified, only -YYYYMMDD was stripped, so every dated OpenAI id
    // fell through to no capability entry and silently received no reasoning object at all.
    expect(supportsEffort("gpt-5.5-2026-04-23")).toBe(true);
    expect(supportsEffort("gpt-5.4-2026-03-05")).toBe(true);
    expect(effortLevelsFor("gpt-5.5-2026-04-23")).toEqual(effortLevelsFor("gpt-5.5"));
    // An unlisted gpt-5* string (reachable via the unvalidated OPENAI_MODEL / ZONE_LLM_MODEL_HIGH
    // env vars) is still correctly unknown — normalization widens nothing it should not.
    expect(supportsEffort("gpt-5.9-unlisted")).toBe(false);
  });

  it("usesAdaptiveThinking: true for adaptive family, false for others", () => {
    expect(usesAdaptiveThinking("claude-opus-5")).toBe(true);
    expect(usesAdaptiveThinking("claude-opus-4-8")).toBe(true);
    expect(usesAdaptiveThinking("claude-opus-4-7")).toBe(true);
    expect(usesAdaptiveThinking("claude-sonnet-5")).toBe(true);
    expect(usesAdaptiveThinking("claude-sonnet-4-6")).toBe(false);
    expect(usesAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(usesAdaptiveThinking("gpt-5.4")).toBe(false);
  });

  it("claude-sonnet-5: effort levels match adaptive bucket (full 5-level range)", () => {
    expect(effortLevelsFor("claude-sonnet-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("claude-opus-5: full 5-level ladder, and xhigh/max survive resolution", () => {
    expect(effortLevelsFor("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The ladder is only useful if the resolver passes the top rungs through rather
    // than clamping them down, which is what a missing MODEL_EFFORT_LEVELS entry does.
    expect(resolveEffortForModel("claude-opus-5", "xhigh")).toBe("xhigh");
    expect(resolveEffortForModel("claude-opus-5", "max")).toBe("max");
  });
});

describe("modelRegistry drift guards", () => {
  it("every EFFORT_SUPPORTED_MODELS entry has a MODEL_EFFORT_LEVELS entry", () => {
    // Intentional omissions (e.g. Haiku) live in MODEL_EFFORT_LEVELS absence by design.
    // This test guards that effort-supported models are never accidentally left out of the levels map.
    const effortSupportedModels = Object.values(MODEL_CATALOG)
      .flat()
      .filter((m) => supportsEffort(m.id))
      .map((m) => m.id);
    const missingLevels = effortSupportedModels.filter((id) => effortLevelsFor(id).length === 0);
    expect(missingLevels).toEqual([]);
  });
});

describe("normalizeModelId — snapshot suffix stripping", () => {
  it("strips -YYYYMMDD suffix", () => {
    expect(normalizeModelId("claude-sonnet-4-6-20260219")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("claude-opus-4-8-20260101")).toBe("claude-opus-4-8");
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("is idempotent on bare aliases", () => {
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("gpt-5.4")).toBe("gpt-5.4");
  });

  it("propagates into effortLevelsFor", () => {
    expect(effortLevelsFor("claude-sonnet-4-6-20260219")).toEqual(effortLevelsFor("claude-sonnet-4-6"));
  });

  it("propagates into supportsEffort", () => {
    expect(supportsEffort("claude-sonnet-4-6-20260219")).toBe(true);
    expect(supportsEffort("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("propagates into usesAdaptiveThinking", () => {
    expect(usesAdaptiveThinking("claude-opus-4-8-20260101")).toBe(true);
    expect(usesAdaptiveThinking("claude-sonnet-4-6-20260219")).toBe(false);
  });
});
