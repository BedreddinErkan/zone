import { describe, it, expect } from "vitest";
import { getProviderForModel, supportsEffort } from "./modelRegistry.js";

describe("modelRegistry", () => {
  it("getProviderForModel returns correct provider for known models", () => {
    expect(getProviderForModel("claude-sonnet-4-6")).toBe("anthropic");
    expect(getProviderForModel("claude-opus-4-7")).toBe("anthropic");
    expect(getProviderForModel("gpt-5.4")).toBe("openai");
    expect(getProviderForModel("gpt-5.4-mini")).toBe("openai");
    expect(getProviderForModel("unknown-model")).toBe("anthropic");  // fallback
  });

  it("supportsEffort returns true for supporting models and false for others", () => {
    expect(supportsEffort("claude-sonnet-4-6")).toBe(true);
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
});
