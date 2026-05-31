import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, isValidModelId, getDefaultModelForTier } from "./models.js";

describe("MODEL_CATALOG", () => {
  it("gpt-4o-mini has workerSuitable: false", () => {
    const entry = MODEL_CATALOG.openai.find((m) => m.id === "gpt-4o-mini");
    expect(entry).toBeDefined();
    expect(entry!.workerSuitable).toBe(false);
  });

  it("gpt-4o-mini has a non-empty workerSuitabilityNote", () => {
    const entry = MODEL_CATALOG.openai.find((m) => m.id === "gpt-4o-mini");
    expect(entry!.workerSuitabilityNote).toBeTruthy();
    expect(entry!.workerSuitabilityNote!.length).toBeGreaterThan(10);
  });

  it("all other models default to worker-suitable (workerSuitable absent or true)", () => {
    for (const [, models] of Object.entries(MODEL_CATALOG)) {
      for (const m of models) {
        if (m.id === "gpt-4o-mini") continue;
        expect(m.workerSuitable === false).toBe(false);
      }
    }
  });

  it("isValidModelId returns true for known models", () => {
    expect(isValidModelId("openai", "gpt-5.4")).toBe(true);
    expect(isValidModelId("openai", "gpt-4o-mini")).toBe(true);
    expect(isValidModelId("anthropic", "claude-sonnet-4-6")).toBe(true);
  });

  it("isValidModelId returns false for unknown models", () => {
    expect(isValidModelId("openai", "gpt-3")).toBe(false);
    expect(isValidModelId("openai", "")).toBe(false);
  });

  it("isValidModelId recognizes gemini-3.5-flash (always registered)", () => {
    expect(isValidModelId("gemini", "gemini-3.5-flash")).toBe(true);
  });

  it("isValidModelId recognizes gemini-3.1-pro (always registered)", () => {
    expect(isValidModelId("gemini", "gemini-3.1-pro")).toBe(true);
  });

  it("getDefaultModelForTier returns recommendedTier model", () => {
    expect(getDefaultModelForTier("openai", "high")).toBe("gpt-5.4");
    expect(getDefaultModelForTier("openai", "standard")).toBe("gpt-5.4-mini");
    expect(getDefaultModelForTier("anthropic", "high")).toBe("claude-sonnet-4-6");
    expect(getDefaultModelForTier("anthropic", "standard")).toBe("claude-haiku-4-5");
  });
});
