import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, isValidModelId, getDefaultModelForTier, MODEL_CONTEXT_WINDOWS, getContextWindow, ESCALATION_LADDERS, nextStrongerModel } from "./models.js";

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


  it("getDefaultModelForTier returns recommendedTier model", () => {
    expect(getDefaultModelForTier("openai", "high")).toBe("gpt-4o");
    expect(getDefaultModelForTier("openai", "standard")).toBe("gpt-4o-mini");
    expect(getDefaultModelForTier("anthropic", "high")).toBe("claude-sonnet-4-6");
    expect(getDefaultModelForTier("anthropic", "standard")).toBe("claude-haiku-4-5");
  });
});

describe("getContextWindow + MODEL_CONTEXT_WINDOWS", () => {
  it("returns correct window for known Claude models", () => {
    expect(getContextWindow("claude-opus-4-8")).toBe(1_000_000);
    expect(getContextWindow("claude-opus-4-7")).toBe(1_000_000);
    expect(getContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
    expect(getContextWindow("claude-haiku-4-5")).toBe(200_000);
  });

  it("returns correct window for known OpenAI models", () => {
    expect(getContextWindow("gpt-4o")).toBe(128_000);
    expect(getContextWindow("gpt-4o-mini")).toBe(128_000);
  });

  it("snapshot-suffix tolerant: resolves via longest-prefix match", () => {
    expect(getContextWindow("claude-sonnet-4-6-20260219")).toBe(1_000_000);
    expect(getContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(getContextWindow("gpt-4o-20260101")).toBe(128_000);
  });

  it("unknown model falls back to conservative 200k default", () => {
    expect(getContextWindow("unknown-model-xyz")).toBe(200_000);
    expect(getContextWindow("")).toBe(200_000);
  });

  it("every model in MODEL_CATALOG has an entry in MODEL_CONTEXT_WINDOWS", () => {
    const allModelIds = Object.values(MODEL_CATALOG).flat().map((m) => m.id);
    const missing = allModelIds.filter((id) => !(id in MODEL_CONTEXT_WINDOWS));
    expect(missing).toEqual([]);
  });
});

describe("nextStrongerModel", () => {
  describe("Anthropic ladder", () => {
    it("haiku → sonnet", () => {
      expect(nextStrongerModel("anthropic", "claude-haiku-4-5")).toBe("claude-sonnet-4-6");
    });
    it("sonnet → opus", () => {
      expect(nextStrongerModel("anthropic", "claude-sonnet-4-6")).toBe("claude-opus-4-8");
    });
    it("opus (top rung) → null", () => {
      expect(nextStrongerModel("anthropic", "claude-opus-4-8")).toBeNull();
    });
  });

  describe("OpenAI ladder", () => {
    it("gpt-4o-mini → gpt-4o", () => {
      expect(nextStrongerModel("openai", "gpt-4o-mini")).toBe("gpt-4o");
    });
    it("gpt-4o → gpt-5.5", () => {
      expect(nextStrongerModel("openai", "gpt-4o")).toBe("gpt-5.5");
    });
    it("gpt-5.5 (top rung) → null", () => {
      expect(nextStrongerModel("openai", "gpt-5.5")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("unknown model → null", () => {
      expect(nextStrongerModel("anthropic", "claude-unknown-9-9")).toBeNull();
      expect(nextStrongerModel("openai", "gpt-99")).toBeNull();
    });
    it("empty string → null", () => {
      expect(nextStrongerModel("anthropic", "")).toBeNull();
    });
  });

  describe("ESCALATION_LADDERS drift validation", () => {
    it("every ladder entry is a valid MODEL_CATALOG model for its provider", () => {
      for (const [provider, ids] of Object.entries(ESCALATION_LADDERS)) {
        for (const id of ids) {
          expect(
            isValidModelId(provider as "anthropic" | "openai", id),
            `ESCALATION_LADDERS["${provider}"] contains "${id}" which is not in MODEL_CATALOG — update the ladder or the catalog`,
          ).toBe(true);
        }
      }
    });
  });
});
