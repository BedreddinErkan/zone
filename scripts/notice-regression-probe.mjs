/**
 * Notice-regression arm probe — does the shipped fix restore discovery behaviour?
 *
 * Three arms measured the tool-absence notice (`llm/toolAbsenceNotice.ts`) causing a
 * regression: with `run_command_readonly` offered and `run_command` withheld, the
 * notice named the withheld root and the agent stopped using the shell it still had.
 * Arm A: notice suppressed (registry seam, below). Arm B: notice as shipped at the
 * time. Arm C (three of the seven tasks only): notice present, `run_command` alone
 * dropped from the named list — arm A: 15 shell calls, 10 discovery; arm B: 0 and 0;
 * arm C: back to arm A's counts, the identical command on two tasks. Two false
 * negatives in arm B: a symbol reported absent that arms A and C found in ten places
 * with one grep, and a stated inability to list directories while holding
 * `run_command_readonly`. All figures above are the earlier pass's own measurements
 * (docs/deferred-work.md item 90), cited here, not re-derived.
 *
 * Two fixes have since shipped: `16ac3419` suppresses a withheld name that is a
 * strict prefix of an offered one — reproducing arm C's condition by construction —
 * and `5392fa6c` disclosed the discovery binaries in the tool's own description
 * (item 91). Neither fix's behavioural effect has ever been measured. Running "arm B"
 * (no suppression) against the CURRENT dist/ build no longer reproduces the ORIGINAL
 * arm B condition — it automatically carries both fixes, which is exactly what
 * answering both items requires in one run. The harness below is otherwise unchanged
 * from what produced arm A/B; arm C's own manual seam (dropping `run_command` from
 * the notice's named list by hand) is NOT carried here — that condition is now the
 * shipped default behaviour of buildToolAbsenceBlock itself, so plain arm B already
 * exercises it. Recovered verbatim from the session transcript that built it
 * (notice.mjs, classify.mjs, promptdiff.mjs — the analysis and prompt-audit logic
 * live in this file too, see buildCaptureRecord and the --audit-prompt step) after
 * the original captures were destroyed twice by /tmp clears; this file exists so a
 * third reconstruction is never needed.
 *
 * MODEL PINNING MATTERS: arms A, B, and C were all measured on claude-sonnet-4-6.
 * --provider/--model default to anthropic/claude-sonnet-4-6 for exactly that reason
 * — a run on any other model or provider is a PORTABILITY measurement, not the
 * verification, and does not answer item 90's or item 91's pending observation.
 *
 * Usage:
 *   npm run build && node scripts/notice-regression-probe.mjs <A|B> <T5|all> <predictionsFile> [capturesDir] [--provider anthropic|openai] [--model MODEL_ID]
 *   node scripts/notice-regression-probe.mjs B all scripts/notice-regression-predictions.example.json
 *   node scripts/notice-regression-probe.mjs A T2,T4,T5 my-predictions.json
 *   node scripts/notice-regression-probe.mjs B all my-predictions.json .zone/audits/notice-regression-arm --provider openai --model gpt-5.5
 *
 * The predictions file is REQUIRED and must exist before this runs — see
 * scripts/notice-regression-predictions.example.json for the shape and what each
 * field means. This is enforced (loadPredictions throws if absent), not a
 * convention to remember.
 *
 * RE-RUN THIS WHEN:
 *   - credit is available again and item 90 / item 91's pending observation is
 *     wanted (this is the primary reason this file exists)
 *   - toolAbsenceNotice.ts's suppression rule changes again
 *   - the QUESTION archetype's offered set (read_file, run_command_readonly) changes
 *   Numbers this script prints are a snapshot of that run, not a constant — nothing
 *   here caches or reuses a prior run's figures.
 *
 * Cost: seven tasks, one arm, projected near $0.35-0.40 based on the two-arm
 * seven-task prior run's ~$0.73 total (item 90). The one-task cost gate below
 * re-derives this per run rather than trusting that projection.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runAgentLoop, assembleAgentSystemPrompt } from "../dist/llm/agentLoop.js";
import { withRequestContext } from "../dist/llm/openaiContext.js";
import { loadDiskKeys } from "../dist/api/diskKeys.js";
import { resolveToolList, listRegisteredTools, registerTool } from "../dist/tools/toolRegistry.js";
import { buildDispatcherCapabilityFilter, QUESTION_PIPELINE } from "../dist/llm/archetypeDispatcher.js";
import { buildToolAbsenceBlock } from "../dist/llm/toolAbsenceNotice.js";
import { createLLMClient } from "../dist/llm/factory.js";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DEFAULT_MODEL = { anthropic: "claude-sonnet-4-6", openai: "gpt-5.5" };
const COST_GATE_USD = 1.5;
const PER_TASK_ABORT_MS = 420_000;

// ---------- Pure parts (no model call, no I/O beyond a read) ----------

/** Loads the frozen ground tasks, filtered by id list or "all". Pure given the file. */
export function loadGroundTasks(snapshotPath, only) {
  const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
  return snap.tasks.filter((t) => !only || only === "all" || only.includes(t.id));
}

/**
 * Loads and minimally validates the operator-written predictions file. Throws
 * (never returns null/undefined) so main() cannot silently proceed without one —
 * the discipline that predictions precede the run is enforced here, not by memory.
 */
export function loadPredictions(path) {
  if (!existsSync(path)) {
    throw new Error(
      `Predictions file required, not found: ${path}. Write it BEFORE running this instrument — ` +
      `see scripts/notice-regression-predictions.example.json for the required shape and field meanings.`
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || !raw.perTask || typeof raw.perTask !== "object") {
    throw new Error(
      `Predictions file at ${path} is missing a "perTask" object. ` +
      `See scripts/notice-regression-predictions.example.json for the required shape.`
    );
  }
  return raw;
}

/** Builds one task's capture record. Pure — no I/O, no model call; `loop` may be a fake. */
export function buildCaptureRecord({ arm, task, model, provider, err, wallMs, aborted, gitClean, gitBefore, gitAfter, loop, iterCap, calls }) {
  return {
    arm, id: task.id, task: task.task, correctFile: task.correctFile,
    model, provider, error: err ?? null, wallMs, aborted: !!aborted,
    gitClean, gitBefore, gitAfter,
    iterCount: loop?.iterCount ?? null,
    iterCap,
    terminationReason: loop?.terminationReason ?? null,
    success: loop?.success ?? null,
    costUsd: loop?.costUsd ?? null,
    tokenUsage: loop?.tokenUsage ?? null,
    onToolCallSeq: calls ?? [],
    toolCallLog: (loop?.toolCallLog ?? []).map((c) => ({
      tool: c.tool, args: c.args, success: c.success,
      resultLen: String(c.result ?? "").length,
      resultHead: String(c.result ?? "").slice(0, 200),
    })),
    summary: String(loop?.summary ?? ""),
  };
}

/**
 * Arm A's seam: disables every registered tool NOT in `offeredNames`, so
 * buildToolAbsenceBlock's own resolveToolList(undefined) call sees an empty absent
 * list — the notice renders nothing — while the offered set itself is untouched.
 * Registry-agnostic: takes the toolRegistry functions as a parameter rather than
 * importing a fixed module, so a test can run this against src/tools/toolRegistry.ts
 * directly. Returns the ORIGINAL tool objects that were disabled, for restoration —
 * this mutates a real module-scoped registry and is not reversed automatically.
 */
export function suppressNonOffered(offeredNames, { listRegisteredTools, registerTool }) {
  const offeredSet = new Set(offeredNames);
  const disabled = [];
  for (const t of listRegisteredTools()) {
    if (!offeredSet.has(t.name)) {
      registerTool({ ...t, isEnabled: () => false });
      disabled.push(t);
    }
  }
  return disabled;
}

/** Restores exactly what suppressNonOffered disabled, by re-registering the originals. */
export function restoreSuppressed(disabled, { registerTool }) {
  for (const t of disabled) registerTool(t);
}

// ---------- Not pure: makes a real, billed call ----------

/** Minimal decisive credit check: one token, one word. Never used for the arm itself. */
export async function probeCredit(client, model) {
  try {
    await client.createChatCompletion({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e && e.message ? e.message : e) };
  }
}

// ---------- CLI orchestration ----------

async function main() {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider") { flags.provider = args[++i]; continue; }
    if (args[i] === "--model") { flags.model = args[++i]; continue; }
    positional.push(args[i]);
  }
  const [ARM, onlyArg, predictionsPath, capturesDirArg] = positional;
  const only = onlyArg && onlyArg !== "all" ? onlyArg.split(",") : null;
  const capturesDir = capturesDirArg || `${REPO}/.zone/audits/notice-regression-arm`;
  const provider = flags.provider || "anthropic";
  const model = flags.model || DEFAULT_MODEL[provider];

  if (!["A", "B"].includes(ARM) || !predictionsPath) {
    console.error(
      "usage: notice-regression-probe.mjs <A|B> <T5|all> <predictionsFile> [capturesDir] " +
      "[--provider anthropic|openai] [--model MODEL_ID]"
    );
    process.exit(2);
  }
  if (!DEFAULT_MODEL[provider]) {
    console.error(`unknown --provider "${provider}"; expected anthropic or openai`);
    process.exit(2);
  }
  if (model !== "claude-sonnet-4-6") {
    console.error(
      `[notice-arm] WARNING: model="${model}" (provider="${provider}") is not claude-sonnet-4-6. ` +
      `Arms A, B, and C were all measured on claude-sonnet-4-6 — this run is a PORTABILITY measurement, ` +
      `not a verification of item 90's or item 91's pending observation.`
    );
  }

  // Predictions are loaded BEFORE any key resolution or model call, per design —
  // there is no path from here to a model call without this succeeding first.
  const predictions = loadPredictions(predictionsPath);
  console.error(`[notice-arm] predictions loaded from ${predictionsPath}: ${Object.keys(predictions.perTask).length} task(s), anyRefusal=${predictions.anyRefusal}`);

  mkdirSync(capturesDir, { recursive: true });

  const apiKey = (await loadDiskKeys()).keys.find((k) => k.provider === provider)?.key;
  if (!apiKey) {
    console.error(`[notice-arm] no ${provider} key via production seam (loadDiskKeys) — stopping`);
    process.exit(2);
  }

  const client = createLLMClient({ provider, apiKey });
  const credit = await probeCredit(client, model);
  if (!credit.ok) {
    console.error(`[notice-arm] CREDIT PROBE FAILED — stopping before any task. ${credit.message}`);
    process.exit(3);
  }
  console.error(`[notice-arm] credit probe OK (provider=${provider} model=${model})`);

  // Prompt audit — zero model calls. Proves the two arms' prompts differ by exactly
  // the notice, and records the current lengths/content for later audit without
  // needing this transcript. Runs unconditionally, before any registry mutation.
  const capabilityFilter = buildDispatcherCapabilityFilter({ ...QUESTION_PIPELINE });
  const offered = resolveToolList(capabilityFilter).map((t) => t.name).sort();
  if (JSON.stringify(offered) !== JSON.stringify(["read_file", "run_command_readonly"])) {
    console.error(`[notice-arm] FATAL: offered set is ${JSON.stringify(offered)}, expected exactly [read_file, run_command_readonly]`);
    process.exit(4);
  }
  const notice = buildToolAbsenceBlock({
    offeredToolNames: new Set(offered), filterSource: "capabilityFilter",
    archetype: "question", tier: "medium", mode: "patch",
  });
  const commonPromptInput = {
    agentIntro: "You are Zone.", frameworkLines: [], hasFramework: false,
    projectMemoryBlock: "", importContextSummary: undefined,
    baseMaxIterations: QUESTION_PIPELINE.iterCap, canRunCommand: false,
    backgroundCommandBlock: "", repoPath: REPO,
    planProgressBlock: "", planAnnotationsBlock: "", auditFindings: undefined,
    archetype: "question", planApproved: undefined,
  };
  const sysNoNotice = assembleAgentSystemPrompt({ ...commonPromptInput, toolAbsenceBlock: "" });
  const sysWithNotice = assembleAgentSystemPrompt({ ...commonPromptInput, toolAbsenceBlock: notice });
  writeFileSync(`${capturesDir}/system-prompt-no-notice.txt`, sysNoNotice);
  writeFileSync(`${capturesDir}/system-prompt-with-notice.txt`, sysWithNotice);
  console.error(
    `[notice-arm] prompt audit: notice=${notice.length} chars, no-notice=${sysNoNotice.length} chars, ` +
    `with-notice=${sysWithNotice.length} chars, delta==notice.length: ${sysWithNotice.length - sysNoNotice.length === notice.length}`
  );

  let disabled = [];
  if (ARM === "A") {
    disabled = suppressNonOffered(offered, { listRegisteredTools, registerTool });
    const after = resolveToolList(capabilityFilter).map((t) => t.name).sort();
    if (JSON.stringify(after) !== JSON.stringify(offered)) {
      console.error("[notice-arm] FATAL: suppression changed the offered set — aborting");
      restoreSuppressed(disabled, { registerTool });
      process.exit(3);
    }
  }
  console.error(`[notice-arm] arm=${ARM} offered=[${offered.join(", ")}] suppressed=${disabled.length}`);

  const tasks = loadGroundTasks(`${REPO}/src/repo/rankerBaseline.snapshot.json`, only);
  const gitStatus = () => execFileSync("git", ["status", "-s"], { cwd: REPO }).toString().trim();
  const outFile = `${capturesDir}/arm${ARM}-${only ? only.join("_") : "all"}-${Date.now()}.json`;

  const results = [];
  let stoppedOnCostGate = false;
  try {
    for (let idx = 0; idx < tasks.length; idx++) {
      const t = tasks[idx];
      const before = gitStatus();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PER_TASK_ABORT_MS);
      const calls = [];
      const t0 = Date.now();
      let loop = null, err = null;

      try {
        loop = await withRequestContext(
          { modelOverride: { high: model, standard: model } },
          () => runAgentLoop({
            task: t.task, repoPath: REPO, runId: `noticearm${ARM}-${t.id}-${Date.now()}`,
            provider, userApiKey: apiKey, abortSignal: ac.signal, mode: "patch",
            capabilityFilter,
            maxIterationsOverride: QUESTION_PIPELINE.iterCap,
            coachingBudgetOverride: QUESTION_PIPELINE.coachingBudget,
            taskClassification: {
              tier: "medium", estimatedFiles: 1, estimatedIterations: 3, confidence: 1,
              classifierCostUsd: 0, classifierLatencyMs: 0, classifierModel: "pinned-by-instrument",
              fallbackUsed: false, archetype: "question", archetypeConfidence: 1,
            },
            onToolCall: (name, callArgs) => { calls.push({ at: Date.now() - t0, name, args: callArgs }); },
          })
        );
      } catch (e) {
        err = String(e && e.stack ? e.stack : e).slice(0, 2000);
      }
      clearTimeout(timer);
      const wallMs = Date.now() - t0;
      const after = gitStatus();

      const rec = buildCaptureRecord({
        arm: ARM, task: t, model, provider, err, wallMs, aborted: ac.signal.aborted,
        gitClean: before === after, gitBefore: before, gitAfter: after,
        loop, iterCap: QUESTION_PIPELINE.iterCap, calls,
      });
      results.push(rec);
      writeFileSync(outFile, JSON.stringify({ arm: ARM, model, provider, offered, predictions, results }, null, 2));

      console.error(
        `[notice-arm] ${t.id}: iters=${rec.iterCount}/${rec.iterCap} term=${rec.terminationReason} ` +
        `cost=$${(rec.costUsd ?? 0).toFixed(4)} wall=${(wallMs / 1000).toFixed(1)}s ` +
        `toolCalls=${rec.toolCallLog.length} gitClean=${rec.gitClean}${err ? " ERR" : ""}`
      );

      if (idx === 0) {
        const projected = (rec.costUsd ?? 0) * tasks.length;
        console.error(`[notice-arm] cost gate: task 1 = $${(rec.costUsd ?? 0).toFixed(4)}, projected ${tasks.length}-task total = $${projected.toFixed(4)} (gate: $${COST_GATE_USD})`);
        if (projected > COST_GATE_USD) {
          console.error(`[notice-arm] COST GATE EXCEEDED — stopping after task 1. Captures for this task are saved at ${outFile}.`);
          stoppedOnCostGate = true;
          break;
        }
      }
    }
  } finally {
    if (ARM === "A") restoreSuppressed(disabled, { registerTool });
  }

  const totCost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  console.error(`\n[notice-arm] TOTAL cost=$${totCost.toFixed(4)} over ${results.length} task(s)${stoppedOnCostGate ? " (stopped on cost gate)" : ""}`);
  console.error(`[notice-arm] captures written to ${outFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[notice-arm] FATAL:", e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
