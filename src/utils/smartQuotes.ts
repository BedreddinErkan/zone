// Phase V Commit 2: Unicode curly-quote → ASCII normalization for FIND/REPLACE blocks.
const SMART_QUOTE_MAP: Record<string, string> = {
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
};
export function normalizeSmartQuotes(s: string): { text: string; count: number } {
  let count = 0;
  const text = s.replace(/[“”‘’]/g, (ch) => {
    count++;
    return SMART_QUOTE_MAP[ch] ?? ch;
  });
  return { text, count };
}
