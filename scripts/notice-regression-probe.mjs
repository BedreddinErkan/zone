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
 * live in this file too, see buildCaptureRecord and the prompt-audit step in main() —
 * it runs unconditionally on every invocation (zero model calls, two file writes)
 * rather than behind a flag; an earlier version of this comment described one, and
 * that was wrong rather than merely stale — nothing in main() ever parsed it) after
 * the original captures were destroyed twice by /tmp clears; this file exists so a
 * third reconstruction is never needed.
 *
 * SCORING (item 144): the discovery metric used to exist only as prose in
 * notice-regression-predictions.example.json, attributed to a classify.mjs not in
 * this repo. isDiscoveryCommand/scoreTaskDiscovery/compareDiscovery below are that
 * definition now, with every reading the prose left open resolved and commented at
 * the point of decision — including the ruling that a refused call, even a
 * discovery-shaped one, never executed and does not count. main() scores every run's
 * own results and writes the comparison into the same JSON it already writes, under a
 * "scored" key. validatePredictions checks predictions against the readme's own four
 * field rules and warns rather than throws, so a malformed historical prediction stays
 * loadable rather than becoming an unrecoverable record.
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
import { readProjectMemoryBlock } from "../dist/memory/projectMemory.js";

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
  const validationWarnings = validatePredictions(raw);
  for (const w of validationWarnings) {
    console.warn(`[notice-arm] predictions validation: ${w}`);
  }
  return { ...raw, validationWarnings };
}

/**
 * Item 144: validates predictions against the readme's own stated field rules —
 * discoveryCount an integer >= 0, falseNegativeResolves true/false/null, anyRefusal
 * (top-level) true/false, rationale (top-level) a non-empty string. Returns one
 * human-readable warning string per violation; never throws, never mutates its input.
 * A field that is absent is not flagged here — that is a different, already-handled
 * gap (compareDiscovery reports discoveryMatch: null for an absent per-task entry).
 *
 * WARN, never throw — deliberately different from loadPredictions' own two structural
 * checks (file missing, perTask missing), which stay hard failures because nothing
 * downstream can run at all without them. A field-level violation is different in
 * kind: the real historical T2/T4 predictions file this instrument was scored against
 * already contains one (a recorded discoveryCount of 1.5), and that file is a record of
 * what was actually predicted before that run happened. Throwing here would make the
 * file unloadable and destroy the record rather than flag it. Every violation is still
 * surfaced loudly — via this return value and loadPredictions' own console.warn per
 * entry — never silently coerced or dropped.
 */
export function validatePredictions(raw) {
  const warnings = [];
  const perTask = raw?.perTask ?? {};
  for (const [taskId, pred] of Object.entries(perTask)) {
    if (pred?.discoveryCount !== undefined) {
      const v = pred.discoveryCount;
      if (!Number.isInteger(v) || v < 0) {
        warnings.push(`perTask.${taskId}.discoveryCount: expected an integer >= 0, got ${JSON.stringify(v)}`);
      }
    }
    if (pred?.falseNegativeResolves !== undefined) {
      const v = pred.falseNegativeResolves;
      if (v !== true && v !== false && v !== null) {
        warnings.push(`perTask.${taskId}.falseNegativeResolves: expected true, false, or null, got ${JSON.stringify(v)}`);
      }
    }
  }
  if (raw?.anyRefusal !== undefined && raw.anyRefusal !== true && raw.anyRefusal !== false) {
    warnings.push(`anyRefusal: expected true or false, got ${JSON.stringify(raw.anyRefusal)}`);
  }
  if (raw?.rationale === undefined || typeof raw.rationale !== "string" || raw.rationale.trim() === "") {
    warnings.push(`rationale: required, expected a non-empty string, got ${JSON.stringify(raw?.rationale)}`);
  }
  return warnings;
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

/**
 * OpenAI's Responses API rejects max_output_tokens below this floor — measured directly
 * (not assumed, not read from a comment): a probe call with max_tokens:1 returned
 * `400 Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16,
 * but got 1 instead.` There is nothing to reuse instead of this number: the adapter's own
 * conversion (responsesConvertParams.ts's max_output_tokens mapping) is a bare pass-through
 * with no floor or clamp anywhere in the chain, and the installed openai SDK's own type
 * definitions for max_output_tokens carry no documented minimum either — this constant is
 * the API's own stated validation rule, quoted exactly, not padded or rounded.
 */
const OPENAI_MIN_OUTPUT_TOKENS = 16;

/**
 * Pure: the credit probe's request parameters, per provider. Separated from probeCredit
 * itself specifically so the one provider-shaped assumption in this file (the output-token
 * floor above) is testable without a call — the gap the first OpenAI run of this instrument
 * found: it gates every run on both providers and was not among the four pure parts pinned
 * when this file was first committed.
 */
export function buildCreditProbeParams(model, provider) {
  const maxTokens = provider === "openai" ? OPENAI_MIN_OUTPUT_TOKENS : 1;
  return { model, messages: [{ role: "user", content: "hi" }], max_tokens: maxTokens };
}

/**
 * Item 144: the discovery-command definition, formerly prose only ("ls, find, fd, grep,
 * rg, git grep, git ls-files — the DISCOVERY regex in the recovered classify.mjs logic")
 * attributed to a file this repo does not have. This IS that definition now — a single
 * place to change what counts, and the mutation target for whether the set is complete.
 */
export const DISCOVERY_BINARIES = ["ls", "find", "fd", "grep", "rg", "git grep", "git ls-files"];

// Derived once, off DISCOVERY_BINARIES itself — never hardcoded separately — so the
// array is the one source of truth for both halves of the check below. An entry added
// here (in either direction) changes what isDiscoveryCommand recognizes without any
// change to its body.
const DISCOVERY_SINGLE = new Set(DISCOVERY_BINARIES.filter((b) => !b.includes(" ")));
const DISCOVERY_COMPOUND = new Set(DISCOVERY_BINARIES.filter((b) => b.includes(" ")));

/**
 * Item 144: whether a run_command_readonly command string is discovery-shaped. Splits on
 * shell chain/pipe operators and checks only the LEADING token(s) of each segment —
 * never a whole-string scan. The prose gave no matching rule at all; a whole-string
 * regex was considered and rejected because it is wrong in two different ways, each
 * absent from every real capture this was built against but both real risks: a
 * discovery word inside a quoted search argument (`npm test -- "please find the failing
 * test"` — npm test is invoked, "find" sits inside a quoted string) and a discovery word
 * as a word-boundary-delimited substring of a path or flag unrelated to the invoked
 * command (`cat logs/find-output.log` — cat is invoked, "find" is delimited by / and -
 * inside a filename). A bareword regex reads both as discovery=true; both are false.
 */
export function isDiscoveryCommand(command) {
  const segments = String(command ?? "").split(/\|\||&&|\||;/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (DISCOVERY_COMPOUND.has(tokens.slice(0, 2).join(" "))) return true;
    if (DISCOVERY_SINGLE.has(tokens[0])) return true;
  }
  return false;
}

/**
 * Item 144: whether a run_command_readonly call was refused by checkCommandSafe before
 * ever executing, as opposed to executing and failing. Matches the literal prefix
 * toolExecutor.ts writes for a block ("Command blocked: ...") — a positive signal,
 * confirmed by reading both exit-header sites there, rather than the absence of the
 * "[exit_code=" prefix an executed call (success OR failure) always carries. A real
 * captured call fails with exit_code=2 and is still a genuine, executed rg search —
 * conflating "failed" with "refused" would misclassify it.
 */
export function isRefusal(resultHead) {
  return String(resultHead ?? "").startsWith("Command blocked:");
}

/**
 * Item 144: scores one task's discovery behaviour from its captured toolCallLog. Three
 * readings the prose left open, resolved here rather than left implicit:
 *   - UNIT: one per qualifying CALL, not one per qualifying segment within a call. A
 *     call piping two discovery binaries together (`find . | grep foo`) counts once.
 *     The prose's own word is "calls"; nothing in it or in the historical figures
 *     ("fifteen shell calls ... ten of them discovery") counts one pipeline twice. The
 *     alternative — counting per matching segment — was considered and rejected on
 *     that basis.
 *   - SUCCESS: counted regardless of the call's own `success` flag. A failed-but-
 *     genuine rg invocation is discovery-shaped by what was invoked, not by whether it
 *     succeeded — a different question from refusal, answered next.
 *   - REFUSAL (the ruling): a refused call does NOT count toward discoveryCount, even
 *     when its command is discovery-shaped. A blocked command never executed, produced
 *     no output, and showed the agent nothing — item 90 asks whether the notice leads
 *     the agent to discover, and an attempt the shell refused is not a discovery. The
 *     rejected alternative: counting attempts (discovery-shaped commands regardless of
 *     refusal) would measure intent, a different metric from the one the prose defines
 *     ("count of ... calls", read here as calls that ran). A refused discovery-shaped
 *     call is never silently dropped — it survives in `refusedCalls` and, singled out,
 *     in `refusedDiscoveryShapedCalls`, so the ruling's effect stays auditable.
 * Returns the derived count alongside the raw calls it came from — the derived field
 * must never be the only record of what happened (item 128's lesson, applied here).
 */
export function scoreTaskDiscovery(toolCallLog) {
  const allShellCalls = (toolCallLog ?? []).filter((c) => c.tool === "run_command_readonly");
  const refusedCalls = allShellCalls.filter((c) => isRefusal(c.resultHead));
  const discoveryCalls = allShellCalls.filter(
    (c) => isDiscoveryCommand(c.args?.command) && !isRefusal(c.resultHead)
  );
  const refusedDiscoveryShapedCalls = allShellCalls.filter(
    (c) => isDiscoveryCommand(c.args?.command) && isRefusal(c.resultHead)
  );
  return {
    discoveryCount: discoveryCalls.length,
    discoveryCalls: discoveryCalls.map((c) => c.args?.command ?? ""),
    allShellCalls: allShellCalls.map((c) => c.args?.command ?? ""),
    refused: refusedCalls.length > 0,
    refusedCalls: refusedCalls.map((c) => c.args?.command ?? ""),
    refusedDiscoveryShapedCalls: refusedDiscoveryShapedCalls.map((c) => c.args?.command ?? ""),
  };
}

/**
 * Item 144: mechanical comparison of scored results against the predictions file
 * loadPredictions returns. `discoveryCount` and `anyRefusal` are compared directly —
 * both are derivable purely from toolCallLog. `falseNegativeResolves` is NOT
 * auto-judged: the two real T2/T4 summaries this was built against resolve their false
 * negatives in free prose ("I found problemWordsPresent in: ..." / "the relevant
 * implementation is under src/tools") that a regex cannot safely interpret without
 * risking a wrong answer presented as a measurement. Surfaced for a human to read
 * instead, explicitly marked as such rather than silently skipped.
 */
export function compareDiscovery(predictions, scoredResults) {
  const perTask = {};
  let anyRefusalActual = false;
  for (const r of scoredResults) {
    const pred = predictions.perTask?.[r.taskId];
    const predictedCount = pred?.discoveryCount;
    if (r.refused) anyRefusalActual = true;
    perTask[r.taskId] = {
      predictedDiscoveryCount: predictedCount ?? null,
      actualDiscoveryCount: r.discoveryCount,
      discoveryMatch: predictedCount === undefined ? null : predictedCount === r.discoveryCount,
      predictedFalseNegativeResolves: pred?.falseNegativeResolves ?? null,
      actualSummary: r.summary ?? null,
      requiresHumanJudgment: pred?.falseNegativeResolves !== undefined && pred?.falseNegativeResolves !== null,
    };
  }
  return {
    perTask,
    anyRefusal: {
      predicted: predictions.anyRefusal ?? null,
      actual: anyRefusalActual,
      match: predictions.anyRefusal === undefined ? null : predictions.anyRefusal === anyRefusalActual,
    },
  };
}

// ---------- Not pure: makes a real, billed call ----------

/** Minimal decisive credit check: as few tokens as each provider's own API accepts. Never used for the arm itself. */
export async function probeCredit(client, model, provider) {
  try {
    await client.createChatCompletion(buildCreditProbeParams(model, provider));
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e && e.message ? e.message : e) };
  }
}

// ---------- Not pure (writes two files), but makes NO model call ----------

/**
 * Item 150, half 1: the two prompt dumps this writes used to omit `offeredToolNames`
 * from the assembly, and the assembler's own isOffered(...) fail-opens an unset set to
 * "offered" — so both dumps rendered every write-tool block (PATCH RULES, APPLY_ROLLED_BACK,
 * TASK SUBAGENTS, SEARCH FIRST, five more) that this archetype's real run, which does pass
 * the real offered set, never sees. `offeredToolNames` here is built ONCE and reused at
 * both assembly calls and in the returned `offeredToolNamesUsed` field, so a test asserting
 * on the return value is asserting on the exact Set that reached assembleAgentSystemPrompt
 * — not a separately-computed value that could silently diverge from it.
 *
 * Item 150, half 2: the two filenames used to be fixed, so a second arm silently
 * overwrote a first arm's dumps. runTag mirrors the exact expression main() already uses
 * for a capture file's own name (arm+task-selection+timestamp), passed in as `runStamp`
 * rather than computed here, so a dump pair and the capture file it accompanies share one
 * stamp by construction rather than by two independent Date.now() calls agreeing by luck.
 *
 * Extracted out of main() so it can run without the credit probe ahead of it — main()'s
 * own process.exit(4) becomes a throw here, since a unit a test imports must not be able
 * to kill the runner; main() catches it and preserves the original exit code and message.
 *
 * Two more fields closed here, established by comparing this function's own output against
 * a reference built independently from the real `assembleAgentSystemPrompt` call site in
 * agentLoop.ts, for this instrument's one configuration (question archetype, no framework,
 * no executionPlan, no subagent): agentIntro was hardcoded to a shorter, unrelated string —
 * the real call site's ternary always resolves to the literal below for this configuration,
 * since the chat/investigation/subagent branches are all unreachable from this instrument
 * and no framework is ever detected (the probe never passes one). projectMemoryBlock was
 * omitted entirely — the real call site reads it unconditionally, wrapped in the identical
 * try/catch below, so a missing or corrupt memory file degrades to "" exactly as it would in
 * a real run rather than throwing somewhere a real run wouldn't. Every other field in this
 * object was checked pairwise against its real-call-site value and found to already match —
 * including two, qaCommandTool and answerOnly, whose value differs from "omitted" but whose
 * RENDERED output does not, because the assembler's own default equals the real derived
 * value for this configuration; left omitted rather than set to a value with no observable
 * effect and no meaningful test. planProgressBlock also differs in value but never in
 * output — gated on TodoWrite, withheld for this archetype — and closing it would need
 * either a src/ change (exporting a new constant) or a duplicated string as a second source
 * of truth, so it stays "" as a named, currently-inert gap rather than a silent one.
 */
export async function runPromptAudit({ capturesDir, ARM, only, runStamp, memoryRepoPath, renderedRepoPath }) {
  const capabilityFilter = buildDispatcherCapabilityFilter({ ...QUESTION_PIPELINE });
  const offered = resolveToolList(capabilityFilter).map((t) => t.name).sort();
  if (JSON.stringify(offered) !== JSON.stringify(["read_file", "run_command_readonly"])) {
    throw new Error(`[notice-arm] FATAL: offered set is ${JSON.stringify(offered)}, expected exactly [read_file, run_command_readonly]`);
  }
  const notice = buildToolAbsenceBlock({
    offeredToolNames: new Set(offered), filterSource: "capabilityFilter",
    archetype: "question", tier: "medium", mode: "patch",
  });
  const offeredToolNames = new Set(offered);
  let projectMemoryBlock = "";
  try {
    projectMemoryBlock = await readProjectMemoryBlock(memoryRepoPath ?? REPO);
  } catch {
    projectMemoryBlock = "";
  }
  const commonPromptInput = {
    agentIntro: "You are Zone, an AI code agent.", frameworkLines: [], hasFramework: false,
    projectMemoryBlock, importContextSummary: undefined,
    baseMaxIterations: QUESTION_PIPELINE.iterCap, canRunCommand: false,
    backgroundCommandBlock: "", repoPath: renderedRepoPath ?? REPO,
    planProgressBlock: "", planAnnotationsBlock: "",
    archetype: "question", planApproved: undefined, offeredToolNames,
  };
  const sysNoNotice = assembleAgentSystemPrompt({ ...commonPromptInput, toolAbsenceBlock: "" });
  const sysWithNotice = assembleAgentSystemPrompt({ ...commonPromptInput, toolAbsenceBlock: notice });
  const runTag = `arm${ARM}-${only ? only.join("_") : "all"}-${runStamp}`;
  const noNoticePath = `${capturesDir}/system-prompt-no-notice-${runTag}.txt`;
  const withNoticePath = `${capturesDir}/system-prompt-with-notice-${runTag}.txt`;
  writeFileSync(noNoticePath, sysNoNotice);
  writeFileSync(withNoticePath, sysWithNotice);
  console.error(
    `[notice-arm] prompt audit: notice=${notice.length} chars, no-notice=${sysNoNotice.length} chars, ` +
    `with-notice=${sysWithNotice.length} chars, delta==notice.length: ${sysWithNotice.length - sysNoNotice.length === notice.length}`
  );
  return {
    sysNoNotice, sysWithNotice, noNoticePath, withNoticePath, offered, notice,
    capabilityFilter, offeredToolNamesUsed: [...offeredToolNames].sort(),
  };
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
  // Item 150, half 2: computed before the credit probe so the stamp identifies this
  // invocation regardless of that probe's outcome, and shared with outFile below so a
  // dump pair and its capture file are stamp-correlated by construction.
  const runStamp = Date.now();

  const apiKey = (await loadDiskKeys()).keys.find((k) => k.provider === provider)?.key;
  if (!apiKey) {
    console.error(`[notice-arm] no ${provider} key via production seam (loadDiskKeys) — stopping`);
    process.exit(2);
  }

  const client = createLLMClient({ provider, apiKey });
  const credit = await probeCredit(client, model, provider);
  if (!credit.ok) {
    console.error(`[notice-arm] CREDIT PROBE FAILED — stopping before any task. ${credit.message}`);
    process.exit(3);
  }
  console.error(`[notice-arm] credit probe OK (provider=${provider} model=${model})`);

  // Prompt audit — zero model calls. Proves the two arms' prompts differ by exactly
  // the notice, and records the current lengths/content for later audit without
  // needing this transcript. Runs unconditionally, before any registry mutation.
  let audit;
  try {
    audit = await runPromptAudit({ capturesDir, ARM, only, runStamp });
  } catch (e) {
    console.error(String(e && e.message ? e.message : e));
    process.exit(4);
  }
  const { offered, capabilityFilter } = audit;

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
  const outFile = `${capturesDir}/arm${ARM}-${only ? only.join("_") : "all"}-${runStamp}.json`;

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

  // Item 144: score every task's own results and compare against the predictions this
  // run was required to load before it started. Final write, after the per-task
  // incremental ones above, so a crash mid-run still leaves the unscored raw data.
  const scoredResults = results.map((r) => ({
    taskId: r.id,
    summary: r.summary,
    ...scoreTaskDiscovery(r.toolCallLog),
  }));
  const scored = compareDiscovery(predictions, scoredResults);
  writeFileSync(outFile, JSON.stringify({ arm: ARM, model, provider, offered, predictions, results, scored }, null, 2));
  console.error(`[notice-arm] captures written to ${outFile}`);
  for (const [taskId, s] of Object.entries(scored.perTask)) {
    const matchStr = s.discoveryMatch === null ? "no prediction" : s.discoveryMatch ? "MATCH" : "MISMATCH";
    console.error(`[notice-arm] scored ${taskId}: discovery=${s.actualDiscoveryCount} (predicted ${s.predictedDiscoveryCount ?? "?"}, ${matchStr})`);
  }
  console.error(
    `[notice-arm] anyRefusal: actual=${scored.anyRefusal.actual} ` +
    `predicted=${scored.anyRefusal.predicted ?? "?"} match=${scored.anyRefusal.match}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[notice-arm] FATAL:", e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
