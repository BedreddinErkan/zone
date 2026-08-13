/**
 * Tier-agreement probe — how often does the classifier's tier match a frozen label?
 *
 * Measures docs/deferred-work.md item 110's registered prediction (classifier agreement
 * with a hand label, 70-85%) against the frozen set in scripts/tier-agreement-labels.json.
 *
 * Usage:
 *   npm run build && node scripts/tier-agreement-probe.mjs --to 1 --out gate.json     # cost gate
 *   npm run build && node scripts/tier-agreement-probe.mjs --from 2 --out rest.json   # the rest
 *
 * WHAT THIS MEASURES: whether the returned tier equals the frozen label. A disagreement
 * means the two disagree — NOT that the classifier is wrong. It says nothing about whether
 * tier changes outcomes; item 110 itself shows tier reaches only `tokenBudgetCap` for five
 * of seven archetypes.
 *
 * READING THE RESULT — four things confound a naive reading, all recorded per task:
 *   - `fallbackUsed` covers FOUR distinct classifier-side events, not one: an invalid tier
 *     value in the model's own response (`invalid_tier`), a truncated response
 *     (`truncated`), confidence below threshold (`low_tier_confidence`), and a
 *     transport/parse error (`error`). `fallbackKind` reports which one (widened domain,
 *     see `deriveFallbackKind` below); `fallbackReasons` is the verbatim, order-preserved
 *     list of every one of the four that fired for that call — more than one can, and the
 *     comment on `deriveFallbackKind` records which combinations are structurally possible
 *     and why. The classifier's own pre-override tier survives only in the captured
 *     `[zone-tier-low-confidence-fallback]` line, recorded here as `rawTier`. Agreement
 *     computed without that distinction confuses "the model said medium" with "the gate
 *     said medium".
 *   - `wouldBump` is the Q.8 large-file promotion (simple -> medium when the task names a
 *     repo file over 2000 lines). It is DISABLED here via `targetFiles: []` so the
 *     classifier's own judgement is what gets measured, and computed offline instead so the
 *     production-path tier is still reportable. `targetFiles` never reaches the prompt —
 *     it feeds only the post-hoc bump — so disabling it does not change what the model sees.
 *   - an error/timeout fallback is a transport artifact, not a judgement. Retried once,
 *     with both attempts recorded. A low-confidence fallback is NEVER retried: it is part
 *     of the behaviour being measured.
 *   - BOUNDARY (item 128): rows written before <commit hash — filled in by the ledger
 *     pass that closes item 128> predate `fallbackReasons`/`fallbackTaskHashMismatch`/
 *     `fallbackUnattributed` and cannot distinguish `invalid_tier` from `low_confidence` —
 *     both collapsed to `"low_confidence"` under the prior reasoning-regex derivation.
 *     Treat those three fields as absent, not false, on any row from before that commit.
 *
 * RE-RUN THIS WHEN: the classifier prompt changes, the confidence threshold moves, or the
 * frozen label set is replaced. Figures recorded elsewhere from this script are a snapshot
 * anchored to the label file's commit, not a constant.
 *
 * Cost: ~1540 input + ~111 output tokens per call on gpt-4o-mini => ~$0.0003/call,
 * ~$0.012 for 40. Each call also appends one usage row to ~/.zone/usage/local-dev.jsonl
 * (RecordingLLMClient -> recordExecution), which is real spend and is left recorded.
 *
 * TESTABILITY (item 128): every side effect below — reading the API key, reading the
 * label file, calling classifyTask, writing OUT, patching console.log/console.warn —
 * lives inside main(), which only runs when this file is executed directly (the
 * import.meta.url guard at the bottom). scripts/tier-agreement-probe.test.ts imports
 * the pure functions below that guard and never triggers main().
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { classifyTask } from "../dist/llm/taskClassifier.js";

const REPO = process.cwd();
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const FROM = Number(argVal("--from", "1"));
const TO = Number(argVal("--to", "40"));
const OUT = argVal("--out", "results.json");

// --- key: read the file directly. NOT loadDiskKeys(), which can migrate and therefore write.
function readOpenAiKey() {
  const p = path.join(homedir(), ".zone", "keys.json");
  const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  const entry = (parsed.keys || []).find((k) => k.provider === "openai");
  if (!entry || !entry.key) throw new Error("no openai key in " + p);
  return entry.key;
}

// --- Q.8 bump, replicated offline (source: taskClassifier.ts FILE_PATH_REGEX + bumpForLargeFiles)
const FILE_PATH_REGEX =
  /\b(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|go|py|rs|java|json|yaml|yml|md)\b/g;
const THRESHOLD = Number(process.env.ZONE_LARGE_FILE_LOC ?? 2000);
function wouldBump(taskText, tier) {
  if (tier !== "simple") return { would: false, file: null, lines: 0 };
  const paths = [...new Set(taskText.match(FILE_PATH_REGEX) || [])];
  for (const rel of paths) {
    const abs = path.resolve(REPO, rel);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, "utf8").split("\n").length;
    if (lines > THRESHOLD) return { would: true, file: rel, lines };
  }
  return { would: false, file: null, lines: 0 };
}

// --- stdout capture state: installed inside main(), read here by closure. Declaring
// the binding at module scope (empty, no side effect) keeps rawTierFromCapture safe
// to import without triggering the console.log patch that fills it.
let captured = [];
function rawTierFromCapture() {
  const line = captured.find((l) => l.includes("[zone-tier-low-confidence-fallback]"));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf("{"))).classifierTier ?? null;
  } catch {
    return null;
  }
}

// Recomputed rather than imported: taskClassifier.ts's `hashTask` is module-private
// (no `export`). MUST match its algorithm and its `String(...).trim()` normalization
// exactly, or every row false-positives a fallbackTaskHashMismatch — this copy has
// no mechanical guard against the source changing underneath it; see item 128's
// drift-risk note in the pass report. Exported so tests can derive real matching
// (and deliberately mismatching) hashes without a third hand-copy of the algorithm.
export function hashTask(taskDescription) {
  let hash = 5381;
  for (let i = 0; i < taskDescription.length; i += 1) {
    hash = ((hash << 5) + hash) ^ taskDescription.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

// Attribution assert (item 128, req. 5): true when any captured marker's taskHash
// disagrees with the hash of the task text the probe already holds. Exported as its
// own function — rather than left inline in the row-construction below — so it is
// independently testable and has a single, precise mutation target.
export function hasTaskHashMismatch(markers, expectedTaskHash) {
  return markers.some((m) => m.taskHash !== expectedTaskHash);
}

// True when emission was supposed to be unconditional (fallbackUsed) but nothing
// was captured — never silently resolved back to the old reasoning regex (item 128,
// req. 6).
export function isFallbackUnattributed(fallbackUsed, markers) {
  return fallbackUsed === true && markers.length === 0;
}

// Parses [zone-classifier-fallback] warn lines captured during one classifyTask
// call. Exported: this is the unit under test and the mutation target for item 128.
export function parseFallbackMarkers(capturedWarnLines) {
  const out = [];
  for (const line of capturedWarnLines) {
    if (!line.includes("[zone-classifier-fallback]")) continue;
    try {
      const evt = JSON.parse(line.slice(line.indexOf("{")));
      out.push({ reason: evt.reason, taskHash: evt.taskHash });
    } catch {
      // malformed capture line — surfaced via fallbackUnattributed, never thrown
    }
  }
  return out;
}

// Widened derivation (item 128): invalid_tier > truncated > low_tier_confidence >
// error > null. Precedence matters, not just presence — verified by reading
// taskClassifier.ts's control flow, not assumed:
//   - invalid_tier ALWAYS co-emits low_tier_confidence: rejecting the tier field
//     forces parsed.confidence to 0, which unconditionally trips the confidence
//     gate immediately below it in the same call.
//   - truncated(survived) CAN co-emit invalid_tier and, conditionally on the
//     model's own separately-reported confidence value, low_tier_confidence too —
//     neither is forced by truncation itself, unlike the invalid_tier case above.
//   - truncated(NOT survived) ALWAYS co-emits error: the parse failure always
//     throws, and nothing catches it before the outer error-emitting handler.
// invalid_tier and truncated both outrank low_tier_confidence and error precisely
// because the latter two are the generic catch-alls that structurally co-fire
// alongside the more specific signals above them, not independent alternatives.
export function deriveFallbackKind(fallbackUsed, markers) {
  const reasons = markers.map((m) => m.reason);
  if (reasons.includes("invalid_tier")) return "invalid_tier";
  if (reasons.includes("truncated")) return "truncated";
  if (reasons.includes("low_tier_confidence")) return "low_confidence";
  if (fallbackUsed) return "error";
  return null;
}

function isTransportFallback(r) {
  const why = String(r.reasoning || "");
  if (!r.fallbackUsed) return false;
  if (why.includes("low confidence")) return false; // never retried — part of the measurement
  return true;
}

async function main() {
  const labels = JSON.parse(fs.readFileSync("scripts/tier-agreement-labels.json", "utf8"));
  const apiKey = readOpenAiKey();
  const results = [];

  // --- item 128: stderr capture. emitClassifierFallback (taskClassifier.ts) is an
  // unguarded `console.warn("[zone-classifier-fallback]", JSON.stringify(event))` at
  // four call sites (invalid_tier, truncated, low_tier_confidence, error). Same
  // install/reset/restore lifecycle as the console.log capture below, including the
  // same lack of try/finally around the loop and the restore statement — a throw
  // mid-loop leaves both console.log and console.warn permanently patched to the
  // capture functions for the rest of the process. Not fixed here; matched, per
  // docs/deferred-work.md item 128's report.
  let capturedWarn = [];
  const realLog = console.log;
  console.log = (...a) => {
    captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  const realWarn = console.warn;
  console.warn = (...a) => {
    capturedWarn.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };

  for (const t of labels.tasks) {
    if (t.index < FROM || t.index > TO) continue;
    captured = [];
    capturedWarn = [];
    let r = await classifyTask(t.task, {
      provider: "openai",
      userApiKey: apiKey,
      skipCache: true,      // belt-and-braces; the 40 keys were also verified distinct
      targetFiles: [],      // disables the post-hoc Q.8 bump; does NOT reach the prompt
    });
    let retried = false;
    let retryReason = null;
    if (isTransportFallback(r)) {
      retried = true;
      retryReason = String(r.reasoning || "");
      captured = [];
      capturedWarn = [];
      r = await classifyTask(t.task, {
        provider: "openai",
        userApiKey: apiKey,
        skipCache: true,
        targetFiles: [],
      });
    }
    const raw = rawTierFromCapture();
    const bump = wouldBump(t.task, r.tier);
    const fallbackMarkers = parseFallbackMarkers(capturedWarn);
    const expectedTaskHash = hashTask(String(t.task || "").trim());
    results.push({
      index: t.index,
      source: t.source,
      provenance: t.provenance,
      task: t.task,
      label: t.label,
      ambiguous: t.ambiguous,
      returnedTier: r.tier,
      rawTier: raw ?? r.tier, // pre-confidence-gate tier when the gate fired
      archetype: r.archetype,
      confidence: r.confidence,
      archetypeConfidence: r.archetypeConfidence,
      fallbackUsed: r.fallbackUsed === true,
      fallbackKind: deriveFallbackKind(r.fallbackUsed === true, fallbackMarkers),
      fallbackReasons: fallbackMarkers.map((m) => m.reason),
      fallbackTaskHashMismatch: hasTaskHashMismatch(fallbackMarkers, expectedTaskHash),
      fallbackUnattributed: isFallbackUnattributed(r.fallbackUsed === true, fallbackMarkers),
      reasoning: r.reasoning ?? null,
      classifierModel: r.classifierModel,
      costUsd: r.classifierCostUsd,
      latencyMs: r.classifierLatencyMs,
      productionTier: bump.would ? "medium" : r.tier,
      wouldBump: bump.would,
      bumpFile: bump.file,
      bumpLines: bump.lines,
      retried,
      retryReason,
    });
    realLog(
      `#${String(t.index).padStart(2)} [${t.source}] label=${t.label.padEnd(7)} ` +
        `returned=${r.tier.padEnd(7)} conf=${r.confidence} ` +
        `${r.fallbackUsed ? "FALLBACK " : ""}${bump.would ? "BUMP " : ""}` +
        `$${r.classifierCostUsd.toFixed(6)} ${r.classifierModel}`
    );
  }

  console.log = realLog;
  console.warn = realWarn;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

  const total = results.reduce((s, r) => s + r.costUsd, 0);
  const models = [...new Set(results.map((r) => r.classifierModel))];
  console.log("\n--- " + results.length + " calls ---");
  console.log("models actually used (asserted, not assumed):", JSON.stringify(models));
  console.log("total billed: $" + total.toFixed(6));
  console.log("mean per call: $" + (total / results.length).toFixed(6));
  console.log("projected 40: $" + ((total / results.length) * 40).toFixed(4));
  console.log("wrote " + OUT);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[tier-agreement-probe] FATAL:", e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
