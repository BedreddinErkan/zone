/**
 * OpenAI prompt-cache probe — does Zone actually get cache hits on the Responses API?
 *
 * Zone has no OpenAI-side cache machinery: no breakpoints, no markers, no eligibility
 * gate. Its only lever is an optional `prompt_cache_key` (agentLoop.ts:437-447),
 * attached at one of ~20 call sites, plus `store:false` set unconditionally
 * (responsesConvertParams.ts). Everything else relies on OpenAI's automatic prefix
 * cache. This measures whether that actually produces hits.
 *
 * Usage:
 *   npm run build && node scripts/openai-cache-probe.mjs [repeats]
 *   node scripts/openai-cache-probe.mjs 8      # default 5
 *
 * RE-RUN THIS WHEN:
 *   - gpt-5.6 caching behaviour changes (vendor-side; this cache is best-effort and
 *     its hit rate has been measured swinging 0.586-0.855 on identical input, see
 *     .zone/audits/gpt5-cost-breakdown.md:57)
 *   - anyone attempts to add OpenAI-side cache breakpoints or flips `store`
 *   Numbers recorded elsewhere from this script are a snapshot, not a constant.
 *
 * READING THE RESULT — the evidence is asymmetric:
 *   - ANY run with cached_tokens > 0 proves caching works. A positive cannot happen
 *     by chance, so one observation is definitive.
 *   - Zero is INCONCLUSIVE on its own; it may be a miss rather than an absence.
 *     Only all-zero across every run and every arm supports "no caching", and even
 *     then the sample size belongs in the conclusion.
 *
 * Cost: ~5k input tokens per call on gpt-5.6-luna ($1/MTok) — cents for a full run.
 */

import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { responsesConvertParams } from "../dist/llm/openaiAdapter/responsesConvertParams.js";

// ── Config ───────────────────────────────────────────────────────────────────
const MODEL = "gpt-5.6-luna";
const REPEATS = Math.max(2, Number(process.argv[2] ?? 5) || 5);
const PREFIX_TOKENS = 5_000; // must clear OpenAI's ~1024-token caching floor

// ── API key resolution ───────────────────────────────────────────────────────
function loadApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const raw = readFileSync(join(homedir(), ".zone", "keys.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const entry = (parsed.keys ?? parsed).find?.((k) => k.provider === "openai");
    if (entry?.key) return entry.key;
  } catch { /* fall through */ }
  throw new Error("No OpenAI API key found. Set OPENAI_API_KEY or configure via zone /keys.");
}

const sdk = new OpenAI({ apiKey: loadApiKey(), timeout: 180_000, maxRetries: 0 });

/**
 * Each arm needs its OWN prefix: the cache is prefix-keyed, so two arms sharing a
 * prefix would read each other's entries and the comparison would mean nothing.
 */
function buildPrefix(armName) {
  const head = `ARM:${armName} — Zone OpenAI prompt-cache probe.\n`;
  const SENTENCE = "The quick brown fox jumps over the lazy dog. ";
  // 4 chars ≈ 1 token, the same heuristic convertParams uses.
  const repeats = Math.ceil((PREFIX_TOKENS * 4) / SENTENCE.length);
  return head + SENTENCE.repeat(repeats);
}

/** Zone's own request body, so store/include/prompt_cache_key are what Zone sends. */
function zoneBody(prefix, { store, cacheKey }) {
  const chatParams = {
    model: MODEL,
    messages: [
      { role: "system", content: prefix },
      { role: "user", content: "Reply with the single word: ok" },
    ],
    max_tokens: 16,
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
  };
  const body = responsesConvertParams(chatParams, {});
  if (store !== undefined) body.store = store;
  return body;
}

function rawDetails(usage) {
  const d = usage?.input_tokens_details ?? {};
  return {
    input_tokens: usage?.input_tokens ?? 0,
    cached_tokens: d.cached_tokens ?? 0,
    cache_write_tokens: d.cache_write_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
  };
}

async function runArm(armName, opts) {
  const prefix = buildPrefix(armName);
  const rows = [];
  console.log(`\n── arm: ${armName} (${JSON.stringify(opts)}) ──`);
  for (let i = 1; i <= REPEATS; i++) {
    const resp = await sdk.responses.create(zoneBody(prefix, opts));
    const r = rawDetails(resp.usage);
    // Partition check against RAW API numbers. Checking Zone's own buckets would be
    // circular — the mapping enforces the partition by construction, so only the
    // untouched response can falsify the subset assumption extractUsage relies on.
    const residual = r.input_tokens - r.cached_tokens - r.cache_write_tokens;
    rows.push({ ...r, residual });
    console.log(
      `  run ${i}: input=${r.input_tokens} cached=${r.cached_tokens} ` +
      `write=${r.cache_write_tokens} out=${r.output_tokens} ` +
      `| input−cached−write = ${residual}${residual < 0 ? "  ** NEGATIVE **" : ""}`
    );
  }
  return rows;
}

function summarize(armName, rows) {
  const hits = rows.filter((r) => r.cached_tokens > 0).length;
  const writes = rows.filter((r) => r.cache_write_tokens > 0).length;
  const negatives = rows.filter((r) => r.residual < 0).length;
  console.log(
    `  summary[${armName}]: cache-read hits ${hits}/${rows.length}` +
    ` · runs reporting writes ${writes}/${rows.length}` +
    ` · partition violations ${negatives}/${rows.length}`
  );
  return { armName, hits, writes, negatives, total: rows.length };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const results = [];

// Baseline: exactly what Zone sends today.
results.push(summarize("baseline", await runArm("baseline", { cacheKey: "zone-run-probe-baseline" })));

// Differential arms only matter if the baseline showed nothing — they turn a null
// result into "no caching, and here is the flag that changes it".
if (results[0].hits === 0) {
  console.log("\nbaseline produced no cache reads — running differential arms");
  results.push(summarize("store-true", await runArm("store-true", { store: true, cacheKey: "zone-run-probe-store" })));
  results.push(summarize("no-cache-key", await runArm("no-cache-key", { cacheKey: undefined })));
}

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log("\n════ verdict ════");
const anyHit = results.some((r) => r.hits > 0);
const anyWrite = results.some((r) => r.writes > 0);
const anyNegative = results.some((r) => r.negatives > 0);

if (anyHit) {
  const b = results[0];
  console.log(`CACHING WORKS — proven by ${results.reduce((n, r) => n + r.hits, 0)} positive observation(s).`);
  console.log(`Baseline hit rate ${b.hits}/${b.total}. A rate below 100% is normal for this cache, not a defect.`);
} else {
  console.log(`NO CACHE READS OBSERVED in ${results.reduce((n, r) => n + r.total, 0)} calls across ${results.length} arm(s).`);
  console.log("Zero is weaker evidence than a positive: this supports, but does not prove, an absence.");
}
console.log(
  anyWrite
    ? "cache_write_tokens: reported non-zero — the mapping added in this increment carries real value."
    : "cache_write_tokens: zero on every run — writes may be piggybacked on uncached input, in which case the gpt-5.6 cache-write RATES are the questionable part, not the mapping."
);
if (anyNegative) {
  console.log(
    "PARTITION VIOLATED: input_tokens − cached − write went negative. The cache buckets are " +
    "reported ADDITIVELY, not as a subset — the input_uncached subtraction in extractUsage is " +
    "wrong and must be reverted (keep the field mapping, drop the cache_write term)."
  );
} else {
  console.log("Partition holds on every run: cached + write never exceeded input_tokens.");
}
