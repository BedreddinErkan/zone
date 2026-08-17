/**
 * Output-composition measurement — Part 2 scouting script.
 *
 * Splits a real Zone session's assistant output into three buckets:
 *   (a) tool_call args  — necessary, agent acting
 *   (b) intermediate narration — trimmable candidate
 *   (c) final summary  — keep, valuable signal
 *
 * Tokenization: chars/4 fallback (tiktoken not in Zone's dependencies).
 * Grounding: ~/.zone/usage/local-dev.jsonl filtered by session time window.
 *
 * Usage: node scripts/output-composition.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Rate constants ────────────────────────────────────────────────────────────
const SONNET_OUTPUT_RATE = 15e-6;   // $15/M output tokens
const HAIKU_OUTPUT_RATE  = 1.25e-6; // $1.25/M output tokens (haiku 4.5)

function modelOutputRate(model) {
  if (!model) return SONNET_OUTPUT_RATE;
  const m = model.toLowerCase();
  if (m.includes("haiku")) return HAIKU_OUTPUT_RATE;
  return SONNET_OUTPUT_RATE; // sonnet, opus, default
}

// ── Session selection: prefer largest Sonnet session ─────────────────────────
function selectSession() {
  const sessDir = join(homedir(), ".zone", "sessions");
  const files = readdirSync(sessDir).filter((f) => f.endsWith(".json"));

  const candidates = files.map((f) => {
    const fp = join(sessDir, f);
    try {
      const d = JSON.parse(readFileSync(fp, "utf-8"));
      return {
        path: fp,
        name: f,
        model: d.model ?? "",
        turns: Array.isArray(d.transcript) ? d.transcript.length : 0,
        size: readFileSync(fp).length,
        startedAt: d.startedAt ?? "",
        lastActivityAt: d.lastActivityAt ?? "",
        raw: d,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  // Sort: prefer Sonnet, then by size desc
  candidates.sort((a, b) => {
    const aIsSonnet = a.model.toLowerCase().includes("sonnet") ? 1 : 0;
    const bIsSonnet = b.model.toLowerCase().includes("sonnet") ? 1 : 0;
    if (bIsSonnet !== aIsSonnet) return bIsSonnet - aIsSonnet;
    return b.size - a.size;
  });

  return candidates[0];
}

// ── Tokenizer: chars/4 ────────────────────────────────────────────────────────
function tok(text) {
  return Math.ceil((text ?? "").length / 4);
}

// ── Usage JSONL: filter by session time window ─────────────────────────────
async function loadUsageForSession(startedAt, lastActivityAt) {
  const jsonlPath = join(homedir(), ".zone", "usage", "local-dev.jsonl");
  const start = new Date(startedAt).getTime();
  const end = new Date(lastActivityAt).getTime();

  let totalOutput = 0;
  let totalCost = 0;
  let matched = 0;

  try {
    const rl = createInterface({
      input: createReadStream(jsonlPath, "utf-8"),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const ts = new Date(r.timestamp ?? "").getTime();
      if (!isNaN(ts) && ts >= start && ts <= end) {
        totalOutput += Number(r.output ?? 0);
        totalCost += Number(r.est_cost_usd ?? 0);
        matched++;
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return null; // no jsonl → fall back
  }

  return matched > 0 ? { totalOutput, totalCost, matched } : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const session = selectSession();
  if (!session) {
    console.error("No session files found in ~/.zone/sessions/");
    process.exit(1);
  }

  const { raw, model, turns, name, startedAt, lastActivityAt } = session;
  const transcript = raw.transcript ?? [];

  console.log(`\n=== output-composition ===`);
  console.log(`Session: ~/.zone/sessions/${name}`);
  console.log(`Model:   ${model} | Turns: ${turns}`);
  console.log(`Period:  ${startedAt} → ${lastActivityAt}`);
  console.log(`Tokenizer: chars/4 fallback (tiktoken not available)`);

  // ── Bucket accumulation ──────────────────────────────────────────────────
  let aChars = 0; // tool_call args
  let bChars = 0; // narration
  let cChars = 0; // assistant_final

  for (const item of transcript) {
    switch (item.kind) {
      case "tool_call":
        // tool name + args string = what the model emitted as output
        aChars += String(item.toolName ?? "").length + 1 + String(item.args ?? "").length;
        break;
      case "narration":
        bChars += String(item.text ?? "").length;
        break;
      case "assistant_final":
        cChars += String(item.text ?? "").length;
        break;
      // user_prompt → input, not output; skip
    }
  }

  const totalChars = aChars + bChars + cChars;

  // ── Ground in real billing ───────────────────────────────────────────────
  let usageSource = "unknown";
  let realOutputTokens;
  let realCostActualModel;

  const usageMatch = await loadUsageForSession(startedAt, lastActivityAt);

  if (usageMatch) {
    realOutputTokens = usageMatch.totalOutput;
    realCostActualModel = usageMatch.totalCost;
    usageSource = `usage JSONL time-window match (${usageMatch.matched} records)`;
  } else {
    // Fall back to pure tokenizer
    realOutputTokens = tok(" ".repeat(totalChars)); // chars/4 of total output chars
    realCostActualModel = realOutputTokens * modelOutputRate(model);
    usageSource = "tokenizer fallback (no JSONL match)";
  }

  // ── Per-bucket token split by char proportion ────────────────────────────
  const ratio = totalChars > 0 ? 1 / totalChars : 0;
  const aTok = Math.round(realOutputTokens * (aChars * ratio));
  const bTok = Math.round(realOutputTokens * (bChars * ratio));
  const cTok = realOutputTokens - aTok - bTok; // remainder to avoid rounding drift

  // ── $ per bucket — ACTUAL model rate ────────────────────────────────────
  const rate = modelOutputRate(model);
  const aCostActual = aTok * rate;
  const bCostActual = bTok * rate;
  const cCostActual = cTok * rate;

  // ── $ per bucket — SONNET equivalent ($15/M) ─────────────────────────────
  const aCostSonnet = aTok * SONNET_OUTPUT_RATE;
  const bCostSonnet = bTok * SONNET_OUTPUT_RATE;
  const cCostSonnet = cTok * SONNET_OUTPUT_RATE;
  const totalCostSonnet = realOutputTokens * SONNET_OUTPUT_RATE;

  const pct = (n) => ((n / (realOutputTokens || 1)) * 100).toFixed(1) + "%";

  console.log(`\nOutput token source: ${usageSource}`);
  console.log(`Actual model rate: $${(rate * 1e6).toFixed(2)}/M output tokens`);
  console.log(`Sonnet-equivalent rate: $${(SONNET_OUTPUT_RATE * 1e6).toFixed(2)}/M (decision column)`);

  // ── Per-bucket table ─────────────────────────────────────────────────────
  const fmt = (n) => String(n).padStart(7);
  const fmtD = (n) => n.toFixed(6).padStart(10);

  console.log(`
Bucket           │ chars   │  tokens │    %  │ actual $ (${model.slice(0,14)}) │ sonnet-equiv $`);
  console.log(`─────────────────┼─────────┼─────────┼───────┼${"─".repeat(26)}┼───────────────`);
  console.log(`(a) tool calls   │ ${fmt(aChars)} │ ${fmt(aTok)} │ ${pct(aTok).padStart(6)} │ ${fmtD(aCostActual)}           │ ${fmtD(aCostSonnet)}`);
  console.log(`(b) narration    │ ${fmt(bChars)} │ ${fmt(bTok)} │ ${pct(bTok).padStart(6)} │ ${fmtD(bCostActual)}           │ ${fmtD(bCostSonnet)}`);
  console.log(`(c) final summ   │ ${fmt(cChars)} │ ${fmt(cTok)} │ ${pct(cTok).padStart(6)} │ ${fmtD(cCostActual)}           │ ${fmtD(cCostSonnet)}`);
  console.log(`─────────────────┼─────────┼─────────┼───────┼${"─".repeat(26)}┼───────────────`);
  console.log(`TOTAL            │ ${fmt(totalChars)} │ ${fmt(realOutputTokens)} │  100% │ ${fmtD(realCostActualModel)}           │ ${fmtD(totalCostSonnet)}`);

  // ── Headline number ──────────────────────────────────────────────────────
  const narrationPct = realOutputTokens > 0 ? (bTok / realOutputTokens) * 100 : 0;
  const narrationSonnetPct = totalCostSonnet > 0 ? (bCostSonnet / totalCostSonnet) * 100 : 0;

  console.log(`\n── Headline ──`);
  console.log(`Intermediate narration: ${bTok.toLocaleString()} tok = ${narrationPct.toFixed(1)}% of output tokens`);
  console.log(`Sonnet-equivalent cost: $${bCostSonnet.toFixed(6)} = ${narrationSonnetPct.toFixed(1)}% of total output $`);

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log(`\n── VERDICT (based on Sonnet-equiv column — upper bound of trimmable headroom) ──`);
  if (narrationSonnetPct > 20) {
    console.log(`REAL HEADROOM: ${narrationSonnetPct.toFixed(1)}% > 20% threshold.`);
    console.log(`Intermediate narration is a meaningful fraction of output cost.`);
    console.log(`A cache-safe brevity lever targeting fluff narration is worth pursuing.`);
    console.log(`(Note: not all narration is trimmable — some is useful TUI UX. This is the upper bound.)`);
  } else if (narrationSonnetPct < 10) {
    console.log(`ALREADY TRIMMED: ${narrationSonnetPct.toFixed(1)}% < 10% threshold.`);
    console.log(`BREVITY RULES have done their job. Output cost arc is in good shape.`);
    console.log(`Attacking narration further is low-leverage; focus elsewhere.`);
  } else {
    console.log(`BORDERLINE: ${narrationSonnetPct.toFixed(1)}% (10–20% range).`);
    console.log(`Modest headroom — a brevity pass would help, but it's not the primary lever.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
