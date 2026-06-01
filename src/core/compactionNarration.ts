export function formatCompactionNarration(opts: {
  tokensBefore: number;
  tokensAfter: number;
  savedTokens: number;
  count: number;
}): string {
  const { tokensBefore, tokensAfter, savedTokens, count } = opts;
  const pct = tokensBefore > 0 ? Math.round((savedTokens / tokensBefore) * 100) : 0;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return `Context compacted: ~${k(tokensBefore)} → ~${k(tokensAfter)} tokens (−${pct}%, #${count})`;
}
