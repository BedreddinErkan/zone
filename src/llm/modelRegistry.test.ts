import { describe, it, expect } from "vitest";
import { getProviderForModel, supportsEffort, usesAdaptiveThinking, normalizeModelId, effortLevelsFor } from "./modelRegistry.js";

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
    expect(supportsEffort("claude-sonnet-4-6")).toBe(true);
    expect(supportsEffort("claude-opus-4-8")).toBe(true);
    expect(supportsEffort("claude-opus-4-7")).toBe(true);
    expect(supportsEffort("claude-sonnet-4-5")).toBe(true);
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsEffort("gpt-5.4")).toBe(true);
    expect(supportsEffort("gpt-5.4-mini")).toBe(true);
    expect(supportsEffort("gpt-5.5")).toBe(true);
    expect(supportsEffort("gpt-5.4-nano")).toBe(false);
    expect(supportsEffort("gpt-4o")).toBe(false);
    expect(supportsEffort("gpt-4o-mini")).toBe(false);
  });

  it("usesAdaptiveThinking: true for adaptive family, false for others", () => {
    expect(usesAdaptiveThinking("claude-opus-4-8")).toBe(true);
    expect(usesAdaptiveThinking("claude-opus-4-7")).toBe(true);
    expect(usesAdaptiveThinking("claude-sonnet-4-6")).toBe(false);
    expect(usesAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(usesAdaptiveThinking("gpt-5.4")).toBe(false);
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
