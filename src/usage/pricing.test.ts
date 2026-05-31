import { describe, expect, it } from "vitest";
import { costFor } from "./pricing.js";

describe("pricing — gemini", () => {
  it("gemini-3.5-flash: input $1.5/MTok", () => {
    expect(costFor("gemini", "gemini-3.5-flash", "input_uncached", 1_000_000)).toBe(1.5);
  });
  it("gemini-3.5-flash: output $9/MTok", () => {
    expect(costFor("gemini", "gemini-3.5-flash", "output", 1_000_000)).toBe(9);
  });
  it("gemini-3.5-flash: cache_read $0.15/MTok", () => {
    expect(costFor("gemini", "gemini-3.5-flash", "cache_read", 1_000_000)).toBe(0.15);
  });
  it("gemini-3.5-flash: cache_write $0 (implicit)", () => {
    expect(costFor("gemini", "gemini-3.5-flash", "cache_write", 1_000_000)).toBe(0);
  });
  it("gemini-3.1-pro: input $4/MTok (conservative flat)", () => {
    expect(costFor("gemini", "gemini-3.1-pro", "input_uncached", 1_000_000)).toBe(4);
  });
  it("gemini-3.1-pro: output $18/MTok", () => {
    expect(costFor("gemini", "gemini-3.1-pro", "output", 1_000_000)).toBe(18);
  });
  it("gemini-3.1-pro: cache_read $0.20/MTok", () => {
    expect(costFor("gemini", "gemini-3.1-pro", "cache_read", 1_000_000)).toBe(0.20);
  });
});

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
