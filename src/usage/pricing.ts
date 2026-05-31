// BYOK pricing table. USD per million tokens.
// Source: vendor pricing pages, May 2026 (verified against platform.claude.com/docs/en/about-claude/pricing and platform.openai.com/api/docs/pricing on 2026-05-08).
// Anthropic cache_write rate is the documented 1.25x base. OpenAI cache writes
// are not separately billed (cached input writes piggyback on uncached input);
// cache_write=0 reflects that.

export type TokenType = "input_uncached" | "cache_write" | "cache_read" | "output";
export type ProviderName = "anthropic" | "openai" | "gemini";

export interface ModelRates {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export const PRICING_USD_PER_MTOK: Record<ProviderName, Record<string, ModelRates>> = {
  anthropic: {
    "claude-opus-4-8":   { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-7":   { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-6":   { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
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
  gemini: {
    // cache_write=0: Gemini implicit caching; write side not separately billed via OpenAI-compat API.
    // gemini-3.1-pro: conservative flat rate (>200K tier); tiered pricing deferred to Gemini.6.
    "gemini-3.5-flash": { input: 1.5, output: 9,  cache_read: 0.15, cache_write: 0 },
    "gemini-3.1-pro":   { input: 4,   output: 18, cache_read: 0.20, cache_write: 0 },
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
  const rate =
    type === "input_uncached"
      ? rates.input
      : type === "output"
        ? rates.output
        : type === "cache_read"
          ? rates.cache_read
          : rates.cache_write;
  return (tokens / 1_000_000) * rate;
}

export function totalCost(
  provider: ProviderName,
  model: string,
  breakdown: Record<TokenType, number>
): number {
  return (Object.keys(breakdown) as TokenType[]).reduce(
    (sum, t) => sum + costFor(provider, model, t, breakdown[t]),
    0
  );
}
