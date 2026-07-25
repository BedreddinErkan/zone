import { describe, expect, it } from "vitest";
import { costFor, formatCostNote, webSearchFee, totalCost, PRICING_USD_PER_MTOK } from "./pricing.js";
import type { ProviderName, TokenType } from "./pricing.js";
import { MODEL_CATALOG } from "../llm/models.js";


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


describe("pricing — claude-sonnet-5", () => {
  it("input $3/MTok (placeholder, mirrors Sonnet 4.6)", () => {
    expect(costFor("anthropic", "claude-sonnet-5", "input_uncached", 1_000_000)).toBe(3);
  });

  it("output $15/MTok", () => {
    expect(costFor("anthropic", "claude-sonnet-5", "output", 1_000_000)).toBe(15);
  });

  it("formatCostNote: $3/$15 per MTok", () => {
    expect(formatCostNote("anthropic", "claude-sonnet-5")).toBe("$3/$15 per MTok");
  });
});

describe("pricing — claude-opus-5", () => {
  it("input $5/MTok", () => {
    expect(costFor("anthropic", "claude-opus-5", "input_uncached", 1_000_000)).toBe(5);
  });

  it("output $25/MTok", () => {
    expect(costFor("anthropic", "claude-opus-5", "output", 1_000_000)).toBe(25);
  });

  it("cache_read $0.50/MTok, cache_write $6.25/MTok", () => {
    expect(costFor("anthropic", "claude-opus-5", "cache_read", 1_000_000)).toBe(0.5);
    expect(costFor("anthropic", "claude-opus-5", "cache_write", 1_000_000)).toBe(6.25);
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

  it("a tiered model discloses the above-threshold rate", () => {
    // Quoting only the base rate would understate a model that can bill double.
    const note = formatCostNote("openai", "gpt-5.6-sol");
    expect(note).toContain("$5/$30 per MTok");
    expect(note).toContain("$10/$45 above 272K input");
  });

  it("a flat model's note is unchanged", () => {
    expect(formatCostNote("openai", "gpt-5.5")).toBe("$5/$30 per MTok");
  });
});

describe("pricing drift guards", () => {
  it("every model in MODEL_CATALOG has a PRICING_USD_PER_MTOK entry for its provider", () => {
    const missing: string[] = [];
    for (const [provider, models] of Object.entries(MODEL_CATALOG)) {
      for (const m of models) {
        if (!PRICING_USD_PER_MTOK[provider as ProviderName]?.[m.id]) {
          missing.push(`${provider}/${m.id}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("pricing — gpt-5.6 long-context threshold", () => {
  const THRESHOLD = 272_000;
  // Only cache_read varies below; input_uncached carries the threshold weight.
  const req = (inputUncached: number, extra: Partial<Record<TokenType, number>> = {}) => ({
    input_uncached: inputUncached, cache_write: 0, cache_read: 0, output: 0, ...extra,
  });

  it("base rates apply below the threshold", () => {
    // 100k uncached input at $5/MTok = $0.50
    expect(totalCost("openai", "gpt-5.6-sol", req(100_000))).toBeCloseTo(0.5, 10);
  });

  it("exactly at the threshold stays on base rates", () => {
    // "above 272K" is strictly greater — at the line the surcharge has not started.
    expect(totalCost("openai", "gpt-5.6-sol", req(THRESHOLD))).toBeCloseTo(1.36, 10);
  });

  it("one token below vs one token above is the full 2x step", () => {
    const below = totalCost("openai", "gpt-5.6-sol", req(THRESHOLD - 1));
    const above = totalCost("openai", "gpt-5.6-sol", req(THRESHOLD + 1));
    expect(below).toBeCloseTo(((THRESHOLD - 1) / 1e6) * 5, 10);
    expect(above).toBeCloseTo(((THRESHOLD + 1) / 1e6) * 10, 10);
    expect(above / below).toBeCloseTo(2, 4);
  });

  it("above the threshold the ENTIRE request re-prices, output included", () => {
    // 300k input + 10k output. Above: input 300k×$10 = $3.00, output 10k×$45 = $0.45
    const cost = totalCost("openai", "gpt-5.6-sol", req(300_000, { output: 10_000 }));
    expect(cost).toBeCloseTo(3.0 + 0.45, 10);
  });

  it("cached reads count toward the threshold and re-price with it", () => {
    // The shape a long agent run produces: tiny uncached delta, huge cached prefix.
    // 5k uncached + 400k cached = 405k input, so the surcharge applies even though
    // input_uncached alone is nowhere near the line.
    const cost = totalCost("openai", "gpt-5.6-sol", req(5_000, { cache_read: 400_000 }));
    expect(cost).toBeCloseTo((5_000 / 1e6) * 10 + (400_000 / 1e6) * 1.0, 10);
  });

  it("terra and luna carry their own tier, not sol's", () => {
    const terra = totalCost("openai", "gpt-5.6-terra", req(300_000));
    const luna = totalCost("openai", "gpt-5.6-luna", req(300_000));
    expect(terra).toBeCloseTo((300_000 / 1e6) * 5, 10);
    expect(luna).toBeCloseTo((300_000 / 1e6) * 2, 10);
  });

  it("a snapshot-suffixed id still resolves the tier", () => {
    // recordingClient prefers the model id the API echoes back, which is dated.
    const dated = totalCost("openai", "gpt-5.6-sol-2026-07-01", req(300_000));
    expect(dated).toBeCloseTo((300_000 / 1e6) * 10, 10);
  });

  it("a model with no tier is unaffected by request size", () => {
    const small = totalCost("openai", "gpt-5.5", req(100_000));
    const huge = totalCost("openai", "gpt-5.5", req(900_000));
    expect(small / 100_000).toBeCloseTo(huge / 900_000, 10);
  });
});

describe("totalCost — unpriced buckets contribute nothing", () => {
  // iterCostMeter passes a five-key breakdown (it tracks output_reasoning), and
  // reasoning tokens are already inside `output`. Before TOKEN_TYPES iteration +
  // the rateFor default, the extra key fell through to the cache-write rate and
  // was billed a second time.
  const base = { input_uncached: 1_000_000, cache_write: 0, cache_read: 0, output: 1_000_000 };

  it("an extra output_reasoning key does not change the total", () => {
    const withoutExtra = totalCost("anthropic", "claude-opus-4-8", base);
    const withExtra = totalCost("anthropic", "claude-opus-4-8", {
      ...base,
      output_reasoning: 1_000_000,
    } as unknown as Record<TokenType, number>);
    expect(withExtra).toBe(withoutExtra);
  });

  it("holds for a model with a non-zero cache_write rate", () => {
    // The rate the stray key used to borrow. Opus bills cache_write at $6.25/MTok,
    // so a regression here would show up as a $6.25 discrepancy on this input.
    const withExtra = totalCost("anthropic", "claude-opus-4-8", {
      input_uncached: 0, cache_write: 0, cache_read: 0, output: 0,
      output_reasoning: 1_000_000,
    } as unknown as Record<TokenType, number>);
    expect(withExtra).toBe(0);
  });

  it("a missing bucket is treated as zero, not NaN", () => {
    const partial = totalCost("anthropic", "claude-opus-4-8", {
      input_uncached: 1_000_000,
    } as unknown as Record<TokenType, number>);
    expect(partial).toBe(5);
  });
});

describe("webSearchFee", () => {
  it("0 searches → $0", () => expect(webSearchFee(0)).toBe(0));
  it("1 search → $0.01", () => expect(webSearchFee(1)).toBe(0.01));
  it("1000 searches → $10", () => expect(webSearchFee(1_000)).toBe(10));
});
