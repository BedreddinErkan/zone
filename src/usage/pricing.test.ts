import { describe, expect, it } from "vitest";
import { costFor, formatCostNote, webSearchFee } from "./pricing.js";
import type { ProviderName } from "./pricing.js";


describe("pricing — claude-opus-4-8", () => {
  it("input $5/MTok", () => {
    expect(costFor("anthropic", "claude-opus-4-8", "input_uncached", 1_000_000)).toBe(5);
  });

  it("output $25/MTok", () => {
    expect(costFor("anthropic", "claude-opus-4-8", "output", 1_000_000)).toBe(25);
  });

  it("cache_read $0.50/MTok (90% off input)", () => {
    expect(costFor("anthropic", "claude-opus-4-8", "cache_read", 1_000_000)).toBe(0.5);
  });

  it("cache_write $6.25/MTok (1.25× input)", () => {
    expect(costFor("anthropic", "claude-opus-4-8", "cache_write", 1_000_000)).toBe(6.25);
  });

  it("snapshot-suffixed alias resolves (claude-opus-4-8-20260529)", () => {
    expect(costFor("anthropic", "claude-opus-4-8-20260529", "input_uncached", 1_000_000)).toBe(5);
  });
});


describe("formatCostNote", () => {
  it("returns formatted rate for known OpenAI models", () => {
    expect(formatCostNote("openai", "gpt-5.5")).toBe("$5/$30 per MTok");
    expect(formatCostNote("openai", "gpt-5.4")).toBe("$2.5/$15 per MTok");
    expect(formatCostNote("openai", "gpt-5.4-mini")).toBe("$0.75/$4.5 per MTok");
    expect(formatCostNote("openai", "gpt-5.4-nano")).toBe("$0.2/$1.25 per MTok");
    expect(formatCostNote("openai", "gpt-4o")).toBe("$2.5/$10 per MTok");
    expect(formatCostNote("openai", "gpt-4o-mini")).toBe("$0.15/$0.6 per MTok");
  });
  it("returns undefined for unknown model — not $0/$0", () => {
    expect(formatCostNote("openai", "nonexistent-model")).toBeUndefined();
  });
  it("returns undefined for unknown provider", () => {
    expect(formatCostNote("gemini" as ProviderName, "some-model")).toBeUndefined();
  });
});

describe("webSearchFee", () => {
  it("0 searches → $0", () => expect(webSearchFee(0)).toBe(0));
  it("1 search → $0.01", () => expect(webSearchFee(1)).toBe(0.01));
  it("1000 searches → $10", () => expect(webSearchFee(1_000)).toBe(10));
});
