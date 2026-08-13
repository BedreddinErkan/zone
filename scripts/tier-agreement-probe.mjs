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
 * READING THE RESULT — three things confound a naive reading, all recorded per task:
 *   - `fallbackUsed` with reason "low confidence" means the tier was OVERWRITTEN to medium
 *     by the confidence gate. The classifier's own tier survives only in the captured
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
 *
 * RE-RUN THIS WHEN: the classifier prompt changes, the confidence threshold moves, or the
 * frozen label set is replaced. Figures recorded elsewhere from this script are a snapshot
 * anchored to the label file's commit, not a constant.
 *
 * Cost: ~1540 input + ~111 output tokens per call on gpt-4o-mini => ~$0.0003/call,
 * ~$0.012 for 40. Each call also appends one usage row to ~/.zone/usage/local-dev.jsonl
 * (RecordingLLMClient -> recordExecution), which is real spend and is left recorded.
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

// --- stdout capture: the raw pre-override tier survives only in the log line.
let captured = [];
const realLog = console.log;
console.log = (...a) => {
  captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
};
function rawTierFromCapture() {
  const line = captured.find((l) => l.includes("[zone-tier-low-confidence-fallback]"));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf("{"))).classifierTier ?? null;
  } catch {
    return null;
  }
}

const labels = JSON.parse(fs.readFileSync("scripts/tier-agreement-labels.json", "utf8"));
const apiKey = readOpenAiKey();
const results = [];

function isTransportFallback(r) {
  const why = String(r.reasoning || "");
  if (!r.fallbackUsed) return false;
  if (why.includes("low confidence")) return false; // never retried — part of the measurement
  return true;
}

for (const t of labels.tasks) {
  if (t.index < FROM || t.index > TO) continue;
  captured = [];
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
    r = await classifyTask(t.task, {
      provider: "openai",
      userApiKey: apiKey,
      skipCache: true,
      targetFiles: [],
    });
  }
  const raw = rawTierFromCapture();
  const bump = wouldBump(t.task, r.tier);
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
    fallbackKind: r.fallbackUsed
      ? (String(r.reasoning || "").includes("low confidence") ? "low_confidence" : "error")
      : null,
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
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

const total = results.reduce((s, r) => s + r.costUsd, 0);
const models = [...new Set(results.map((r) => r.classifierModel))];
console.log("\n--- " + results.length + " calls ---");
console.log("models actually used (asserted, not assumed):", JSON.stringify(models));
console.log("total billed: $" + total.toFixed(6));
console.log("mean per call: $" + (total / results.length).toFixed(6));
console.log("projected 40: $" + ((total / results.length) * 40).toFixed(4));
console.log("wrote " + OUT);
