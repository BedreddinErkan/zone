// BYOK pricing table. USD per million tokens.
// Source: vendor pricing pages, May 2026 (verified against platform.claude.com/docs/en/about-claude/pricing and platform.openai.com/api/docs/pricing on 2026-05-08).
// Anthropic cache_write rate is the documented 1.25x base. OpenAI cache writes
// are not separately billed (cached input writes piggyback on uncached input);
// cache_write=0 reflects that.

export type TokenType = "input_uncached" | "cache_write" | "cache_read" | "output";
export type ProviderName = "anthropic" | "openai";

/** The billable buckets, enumerated. totalCost iterates THIS rather than the keys of
 *  its argument: callers pass wider objects (iterCostMeter adds output_reasoning),
 *  and a bucket we have no rate for must contribute nothing rather than borrow one. */
export const TOKEN_TYPES: readonly TokenType[] = [
  "input_uncached",
  "cache_write",
  "cache_read",
  "output",
];

export interface ModelRates {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export const PRICING_USD_PER_MTOK: Record<ProviderName, Record<string, ModelRates>> = {
  anthropic: {
    "claude-opus-5":     { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    // cache_write is the 5-minute TTL rate. Fable also publishes a 1-hour cache-write
    // rate of $20.00/MTok, deliberately not recorded: Zone only ever sets
    // cache_control {type:"ephemeral"} (5-minute), so a 1-hour field would have no
    // reader and would silently rot out of date.
    "claude-fable-5":    { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
    "claude-opus-4-8":   { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-7":   { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-6":   { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    // TODO: confirm Sonnet 5 pricing — update this the moment real Sonnet 5 billing is observed
    "claude-sonnet-5":   { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-haiku-4-5":  { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  },
  openai: {
    "gpt-5.5":      { input: 5, output: 30, cache_read: 0.50, cache_write: 0 },
    "gpt-5.4":      { input: 2.50, output: 15, cache_read: 0.25, cache_write: 0 },
    "gpt-5.4-mini": { input: 0.75, output: 4.50, cache_read: 0.075, cache_write: 0 },
    "gpt-5.4-nano": { input: 0.20, output: 1.25, cache_read: 0.02, cache_write: 0 },
    "gpt-4o":       { input: 2.50, output: 10, cache_read: 1.25, cache_write: 0 },
    "gpt-4o-mini":  { input: 0.15, output: 0.60, cache_read: 0.075, cache_write: 0 },
  },
};

export function costFor(
  provider: ProviderName,
  model: string,
  type: TokenType,
  tokens: number
): number {
  // Try exact match first; if not found, strip Anthropic-style date
  // suffix (-YYYYMMDD) which the API returns even when the user picked
  // a base alias. Example: "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5".
  let rates = PRICING_USD_PER_MTOK[provider]?.[model];
  if (!rates) {
    const baseModel = model
      .replace(/-\d{8}$/, '')             // Anthropic snapshot: -YYYYMMDD
      .replace(/-\d{4}-\d{2}-\d{2}$/, ''); // OpenAI snapshot: -YYYY-MM-DD
    if (baseModel !== model) {
      rates = PRICING_USD_PER_MTOK[provider]?.[baseModel];
    }
  }
  if (!rates) {
    console.warn(`[zone-pricing] unknown model ${provider}/${model}, cost=0`);
    return 0;
  }
  return (tokens / 1_000_000) * rateFor(rates, type);
}

/**
 * Rate for one billable bucket. Unknown buckets return 0, not a neighbouring rate.
 *
 * This was a ternary chain whose final else returned `cache_write`, so any token
 * type outside the union billed at the cache-write rate. `totalCost` fed it
 * `output_reasoning` (iterCostMeter.ts passes a five-key breakdown), and reasoning
 * tokens are already counted inside `output` — so they were charged twice, at a
 * rate that had nothing to do with them. Harmless only while every model carrying
 * reasoning tokens also had cache_write: 0.
 */
function rateFor(rates: ModelRates, type: TokenType): number {
  switch (type) {
    case "input_uncached": return rates.input;
    case "output":         return rates.output;
    case "cache_read":     return rates.cache_read;
    case "cache_write":    return rates.cache_write;
    default:               return 0;
  }
}

export function totalCost(
  provider: ProviderName,
  model: string,
  breakdown: Record<TokenType, number>
): number {
  // Iterate the known buckets, not Object.keys(breakdown): callers pass wider
  // objects, and an unpriced key must not reach costFor at all.
  return TOKEN_TYPES.reduce(
    (sum, t) => sum + costFor(provider, model, t, breakdown[t] ?? 0),
    0
  );
}

/**
 * Returns a short cost note like "$2.5/$15 per MTok" for display in the model picker.
 * Returns undefined when the model has no pricing entry — never prints $0/$0.
 */
export function formatCostNote(provider: ProviderName, modelId: string): string | undefined {
  const rates = PRICING_USD_PER_MTOK[provider]?.[modelId];
  if (!rates) return undefined;
  const fmt = (n: number) => String(parseFloat(n.toFixed(2)));
  return `$${fmt(rates.input)}/$${fmt(rates.output)} per MTok`;
}

/** Flat per-search fee charged by Anthropic (not model-specific). $10/1000 searches. */
export const WEB_SEARCH_FEE_USD = 0.01;

export function webSearchFee(requests: number): number {
  return requests * WEB_SEARCH_FEE_USD;
}
