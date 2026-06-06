import { describe, expect, it } from "vitest";
import { costFor, webSearchFee } from "./pricing.js";


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

describe("webSearchFee", () => {
  it("0 searches → $0", () => expect(webSearchFee(0)).toBe(0));
  it("1 search → $0.01", () => expect(webSearchFee(1)).toBe(0.01));
  it("1000 searches → $10", () => expect(webSearchFee(1_000)).toBe(10));
});
