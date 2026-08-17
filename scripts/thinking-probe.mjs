/**
 * Anthropic thinking-block probe — does the passthrough do what it was built for?
 *
 * Zone now captures thinking blocks verbatim and replays them on every assistant
 * turn that carried tool_use (src/llm/anthropicAdapter/thinkingBlocks.ts). The
 * mechanism is fully unit-tested. Four things about the API's behaviour are not,
 * and cannot be — they need a live call. This answers all four in one spend.
 *
 * Usage:
 *   npm run build && node scripts/thinking-probe.mjs [model]
 *   node scripts/thinking-probe.mjs claude-opus-5     # default
 *   node scripts/thinking-probe.mjs claude-fable-5    # the display question
 *
 * RE-RUN THIS WHEN:
 *   - a new always-on-thinking model is added to ADAPTIVE_THINKING_MODELS
 *   - THINKING_REPLAY_TURNS is changed, or anyone proposes bounding it
 *   - Anthropic changes thinking.display defaults, or begins returning thinking
 *     for a model that previously omitted it
 *   Numbers recorded from this script are a snapshot, not a constant.
 *
 * WHAT IT ANSWERS — and how to read each one:
 *
 *   1. @unverified-probe(thinking:signature-replay)
 *      Does a replayed block validate? A 200 proves it. A 400 mentioning the
 *      signature proves the opposite and is equally definitive. Any other error
 *      is inconclusive — check the message before concluding.
 *
 *   2. @unverified-probe(thinking:fable-display)
 *      Which block types does this model return? Prints them. If a model returns
 *      no thinking block at all, the passthrough does nothing for it — that is a
 *      real result, not a failure, and it is the one that decides whether this
 *      work pays for Fable 5.
 *
 *   3. @unverified-probe(thinking:older-turn-stripping)
 *      Is an OLDER turn's thinking billed as input? Arm C replays two turns of
 *      thinking; arm B replays one. If input_tokens track the difference, older
 *      thinking is being counted and is real context. If they do not, it is
 *      stripped server-side and the feature's ceiling is one turn of memory.
 *      Note this does NOT change the replay policy either way — a bounded window
 *      breaks prefix caching, which is a client-side fact already measured.
 *
 *   4. @unverified-probe(thinking:token-saving)
 *      Does turn 2 think less when it can see turn 1's reasoning? Compare arm A
 *      (thinking stripped, today's behaviour before this work) against arm B
 *      (thinking replayed) on the SAME two-turn conversation. Lower
 *      thinking_tokens in B is the benefit this increment exists to produce.
 *
 * THE EVIDENCE IS ASYMMETRIC on 4. A single pair proves nothing on its own:
 * thinking budgets vary run to run. Repeat (default 3) and report the spread,
 * not just the means. A difference smaller than the within-arm variance is not
 * a result. n belongs in any number quoted from this.
 *
 * It also records observed signature byte-length, which is the missing input to
 * the envelope-size estimate in the commit log (measured offline at 2.6-4.4KB
 * per turn assuming 200-2000B signatures; this replaces the assumption).
 *
 * Cost: ~8 calls of a few thousand tokens each. Cents, unless run at max effort.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Config ───────────────────────────────────────────────────────────────────
const MODEL = process.argv[2] ?? "claude-opus-5";
const REPEATS = Math.max(1, Number(process.argv[3] ?? 3) || 3);
const MAX_TOKENS = 8192;

// A question whose answer needs derivation, so thinking is non-trivial and turn 2
// has something real to re-derive if it cannot see turn 1's reasoning.
const TASK =
  "A run parks on a question at iteration 4 of 15, having staged edits to 3 files " +
  "but flushed none. The process is then hard-killed. Work out, step by step, " +
  "which of those edits can still be recovered and which cannot. Then call " +
  "record_finding with your conclusion.";

const TOOL = {
  name: "record_finding",
  description: "Record the conclusion of an analysis.",
  input_schema: {
    type: "object",
    properties: {
      recoverable: { type: "string", description: "Which edits survive, and why." },
    },
    required: ["recoverable"],
  },
};

// ── API key resolution ───────────────────────────────────────────────────────
function loadApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const raw = readFileSync(join(homedir(), ".zone", "keys.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const entry = (parsed.keys ?? parsed).find?.((k) => k.provider === "anthropic");
    if (entry?.key) return entry.key;
  } catch { /* fall through */ }
  throw new Error("No Anthropic API key found. Set ANTHROPIC_API_KEY or configure via zone /keys.");
}

let sdk;

function thinkingBlocksOf(content) {
  return content.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
}

function describeBlocks(content) {
  return content.map((b) => b.type).join(", ") || "(empty)";
}

/** Turn 1: ask the question, let the model think, capture whatever comes back. */
async function turnOne() {
  const msg = await sdk.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    tools: [TOOL],
    messages: [{ role: "user", content: TASK }],
  });
  return msg;
}

/**
 * Turn 2: reply to the tool_use and ask for a follow-up that depends on the same
 * derivation. `replay` decides whether turn 1's thinking is present.
 */
async function turnTwo(turn1, { replay, extraThinking }) {
  const assistantBlocks = [];
  if (replay) assistantBlocks.push(...thinkingBlocksOf(turn1.content));
  if (extraThinking) assistantBlocks.push(...extraThinking);
  assistantBlocks.push(...turn1.content.filter((b) => b.type === "text" || b.type === "tool_use"));

  const toolUse = turn1.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("turn 1 produced no tool_use — rerun; the task should force one");

  const msg = await sdk.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    tools: [TOOL],
    messages: [
      { role: "user", content: TASK },
      { role: "assistant", content: assistantBlocks },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUse.id, content: "Recorded." },
          {
            type: "text",
            text: "Now state which single change would make the unrecoverable case recoverable.",
          },
        ],
      },
    ],
  });
  return msg;
}

function usageOf(msg) {
  const u = msg.usage ?? {};
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
  };
}

/** Thinking tokens are inside output_tokens; the API does not break them out, so
 *  measure the blocks directly. 4 chars ≈ 1 token, the heuristic Zone uses. */
function thinkingTokensOf(msg) {
  const chars = thinkingBlocksOf(msg.content)
    .map((b) => (typeof b.thinking === "string" ? b.thinking.length : 0))
    .reduce((a, b) => a + b, 0);
  return Math.ceil(chars / 4);
}

function stats(xs) {
  if (xs.length === 0) return { n: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, min: sorted[0], max: sorted[sorted.length - 1], mean: Math.round(mean) };
}

async function main() {
  console.log(`\nZone thinking-block probe — model=${MODEL}, repeats=${REPEATS}\n`);

  const stripped = [];
  const replayed = [];
  const doubled = [];
  let sawSignatureError = false;
  let signatureLengths = [];
  let blockTypesSeen = new Set();

  for (let i = 1; i <= REPEATS; i++) {
    console.log(`── round ${i} ──`);

    const t1 = await turnOne();
    const blocks = thinkingBlocksOf(t1.content);
    blocks.forEach((b) => {
      blockTypesSeen.add(b.type);
      if (typeof b.signature === "string") signatureLengths.push(b.signature.length);
    });

    console.log(`  turn 1 blocks: ${describeBlocks(t1.content)}`);
    console.log(`  turn 1 thinking≈${thinkingTokensOf(t1)} tok, usage=${JSON.stringify(usageOf(t1))}`);

    if (blocks.length === 0) {
      // (2) The Fable answer, if it is this one.
      console.log(
        "  NO THINKING BLOCK RETURNED — the passthrough has nothing to carry for " +
        `${MODEL}. This is a real result: the increment does not pay for this model.`
      );
      continue;
    }

    // (1) signature-replay + (4) token-saving
    let t2Replay = null;
    try {
      t2Replay = await turnTwo(t1, { replay: true });
      console.log(`  arm B (replayed): thinking≈${thinkingTokensOf(t2Replay)} tok, usage=${JSON.stringify(usageOf(t2Replay))}`);
      replayed.push(thinkingTokensOf(t2Replay));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      sawSignatureError = /signature/i.test(m);
      console.log(`  arm B FAILED: ${m}`);
      if (sawSignatureError) {
        console.log("  → signature validation rejected the replayed block. Definitive negative.");
      }
    }

    const t2Strip = await turnTwo(t1, { replay: false });
    console.log(`  arm A (stripped): thinking≈${thinkingTokensOf(t2Strip)} tok, usage=${JSON.stringify(usageOf(t2Strip))}`);
    stripped.push(thinkingTokensOf(t2Strip));

    // (3) older-turn-stripping: same conversation, thinking replayed TWICE over.
    // If input_tokens rise with the duplicate, older thinking is being billed.
    if (t2Replay) {
      try {
        const t2Double = await turnTwo(t1, { replay: true, extraThinking: thinkingBlocksOf(t1.content) });
        const delta = usageOf(t2Double).input - usageOf(t2Replay).input;
        console.log(`  arm C (thinking twice): input delta vs arm B = ${delta} tok`);
        doubled.push(delta);
      } catch (err) {
        console.log(`  arm C skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log("\n══ results ══");
  console.log(`(1) signature-replay: ${
    replayed.length > 0 ? "ACCEPTED — a replayed block validates" :
    sawSignatureError ? "REJECTED on signature" : "INCONCLUSIVE — no successful replay"
  }`);
  console.log(`(2) fable-display: block types returned by ${MODEL}: ${
    blockTypesSeen.size > 0 ? [...blockTypesSeen].join(", ") : "NONE — nothing to capture"
  }`);
  const sig = stats(signatureLengths);
  console.log(`    signature bytes: ${sig.n ? `${sig.min}-${sig.max} (mean ${sig.mean}, n=${sig.n})` : "n/a"}`);
  console.log(`(3) older-turn-stripping: input delta when thinking is duplicated: ${JSON.stringify(stats(doubled))}`);
  console.log("    delta ≈ 0 ⇒ older thinking stripped server-side; delta ≈ block size ⇒ it is billed and is real context.");
  console.log(`(4) token-saving: turn-2 thinking tokens`);
  console.log(`    arm A (stripped, pre-passthrough): ${JSON.stringify(stats(stripped))}`);
  console.log(`    arm B (replayed):                  ${JSON.stringify(stats(replayed))}`);
  console.log(
    "    A difference smaller than the within-arm spread is NOT a result. " +
    "Quote n alongside any figure taken from this."
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  sdk = new Anthropic({ apiKey: loadApiKey(), timeout: 600_000, maxRetries: 0 });
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
