/**
 * Lever #2 cache-cost probe — dedupe OFF vs ON
 *
 * Synthetic N=12-turn build-error spiral. Both modes go through the real
 * convertParams (real BP#1/BP#2 placement). ON mode uses R2ShimProcessor
 * (pruneStaleReads + dedupeToolOutputs). OFF mode uses pruneStaleReads only.
 *
 * Usage:
 *   npm run build && node scripts/dedupe-cache-probe.mjs
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Imports from compiled dist ───────────────────────────────────────────────
import { pruneStaleReads } from "../dist/llm/contextPruner.js";
import { R2ShimProcessor } from "../dist/llm/history/R2ShimProcessor.js";
import { convertParams } from "../dist/llm/anthropicAdapter/convertParams.js";
import { ZONE_TOOLS } from "../dist/tools/toolDefinitions.js";

// ── Config ───────────────────────────────────────────────────────────────────
const N_TURNS = 12;
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 16; // Fix #3: 16 avoids rejection when tools are present

// ── API key resolution ────────────────────────────────────────────────────────
function loadApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const raw = readFileSync(join(homedir(), ".zone", "keys.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const entry = parsed.keys?.find((k) => k.provider === "anthropic");
    if (entry?.key) return entry.key;
  } catch { /* fall through */ }
  throw new Error("No Anthropic API key found. Set ANTHROPIC_API_KEY or configure via zone /keys.");
}

// ── Synthetic fixtures ────────────────────────────────────────────────────────

// ~12K-char system prompt (realistic Zone-equivalent size, triggers BP#1)
const SYSTEM_PROMPT = `You are an expert software engineer working inside Zone, a self-hosted AI coding agent.

## Role
You execute programming tasks autonomously using tools to read files, apply patches, and run commands. You operate with a strict tier budget — iteration cap, token budget, and coaching quota — and must complete tasks efficiently.

## Execution discipline
- Plan before acting: identify the minimal set of files you need to read.
- Batch file reads. Do not read the same file twice unless it changed.
- Apply patches with apply_patch or multi_edit. Never write prose when code is expected.
- After each patch, run verification (tsc --noEmit or npm run build) to confirm correctness.
- When a build fails, read the compiler output carefully. Fix the exact error on the exact line.
- Do not speculate about errors not in the compiler output.
- Use TodoWrite to maintain a live checklist when handling multi-step tasks.

## Patch rules
- Never invent file paths. Confirm paths with list_files or find_references first.
- apply_patch requires exact context match. If a patch fails, re-read the file.
- multi_edit is preferred for renames and multi-file find-replace (exact string, not regex).
- Never apply a patch that changes unrelated lines.

## Build verification
- Run tsc --noEmit after every patch to catch type errors.
- Run npm run build to confirm the full compilation pipeline succeeds.
- If a build fails with the same error twice in a row, re-read the source file — your patch may not have applied.

## Tool discipline
- read_file: provide lineRange when possible to stay within the 10K-char limit.
- search_in_files: use literal mode for exact identifiers, regex mode for patterns.
- run_command: prefer read-only git commands (git log, git diff, git show) for context.
- Never run destructive commands (git reset --hard, rm -rf) without explicit plan approval.

## Session memory
You have access to project memory (memory.md) and per-session conversation history. Reference prior turns when they are relevant to the current task.

## Cost awareness
- Token budget is enforced per tier: simple (8K), medium (40K), complex (120K).
- Each tool call consumes tokens. Minimize round-trips.
- Avoid re-reading files already in the manifest unless they changed.

## Output format
- End every completed run with a FINAL SUMMARY section.
- FINAL SUMMARY must state: what changed, which files, and verification outcome.
- Do not add prose after the FINAL SUMMARY.

## Error recovery
- On APPLY_ROLLED_BACK: re-read the file, understand why the patch failed, and retry with a corrected patch.
- On repeated build failures: re-read the relevant source file rather than retrying the same patch.
- On scope-block: list the files in the plan scope and identify which file you should be editing instead.

## Git context
When the task involves a regression or recent change, use bounded git reads:
  git log -n 10 --oneline
  git diff --stat HEAD~1
  git show HEAD:src/path/to/file.ts
Never read unlimited git history.

## Subagent guidance
Use Task tool for long, isolated subtasks that do not need your current file context. Do not dispatch subagents for simple single-file patches.

## Archetype-specific notes
- targeted_fix: fix the exact failing line. No refactoring.
- refactor: may touch multiple files; use multi_edit for renames.
- investigation: read-only tools only; summarize findings at the end.
- question: answer from memory and file reads; do not modify files.

## Security
- Never read .env files or secret keys.
- Never commit API keys, tokens, or passwords.
- Use run_command_readonly for safe read-only shell commands.

## Additional context
This repository uses TypeScript (strict mode), Node 22+, Vitest for tests, and ESLint. The build pipeline is: tsc → dist/. Tests run with vitest run. Always rebuild before running tests after patches.

Project structure:
  src/api/          HTTP routes and disk persistence
  src/cli/          CLI entry point and TUI (Ink)
  src/core/         Atomic patch flow and staging
  src/llm/          Agent loop, adapters, context pipeline
  src/tools/        Tool definitions and executor
  src/ui/           Vanilla-TS web frontend

Common commands:
  npm run build     tsc + UI sync
  npm run typecheck tsc --noEmit
  npm test          vitest run
  npm run serve     node dist/cli/index.js serve

The pipeline from user request to completion:
  CLI / HTTP → dispatch → agentLoop → tool executor → verifyAndFinalize → finalizeRun

Keep this context in mind throughout your work. Operate deterministically and efficiently.`.padEnd(12_200, " ").slice(0, 12_200);

// ~2.5K-char build error — FIXED content, identical every turn (the dedupe target)
const BUILD_ERROR = `> zone@0.0.1 build
> node node_modules/typescript/bin/tsc -p tsconfig.json && node scripts/sync-zone-ui.cjs

src/api/server.ts(142,5): error TS2345: Argument of type '{ model: string; messages: ChatCompletionMessageParam[]; tools: ChatCompletionTool[] | undefined; tool_choice: "auto"; max_tokens: number; stream: false; }' is not assignable to parameter of type 'ChatCompletionCreateParamsNonStreaming'.
  Type '{ model: string; messages: ChatCompletionMessageParam[]; tools: ChatCompletionTool[] | undefined; tool_choice: "auto"; max_tokens: number; stream: false; }' is not assignable to type '{ model: (string & {}) | "o1" | "o1-2024-12-17" | ... }'.
    Types of property 'messages' are incompatible.
      Type 'ChatCompletionMessageParam[]' is not assignable to type '(SystemMessageParam | UserMessageParam | AssistantMessageParam | ToolMessageParam | FunctionMessageParam)[]'.
        Type 'ChatCompletionMessageParam' is not assignable to type 'SystemMessageParam | UserMessageParam | AssistantMessageParam | ToolMessageParam | FunctionMessageParam'.
          Type '{ role: "system"; content: string | (ChatCompletionContentPartText | ChatCompletionContentPartRefusal)[]; name?: string; }' is not assignable to type 'SystemMessageParam | UserMessageParam | AssistantMessageParam | ToolMessageParam | FunctionMessageParam'.
            Type '{ role: "system"; content: string | (ChatCompletionContentPartText | ChatCompletionContentPartRefusal)[]; name?: string; }' is not assignable to type 'SystemMessageParam'.
              Types of property 'content' are incompatible.
                Type 'string | (ChatCompletionContentPartText | ChatCompletionContentPartRefusal)[]' is not assignable to type 'string'.
                  Type '(ChatCompletionContentPartText | ChatCompletionContentPartRefusal)[]' is not assignable to type 'string'.
src/api/server.ts(187,3): error TS2322: Type 'string | undefined' is not assignable to type 'string'.
  Type 'undefined' is not assignable to type 'string'.
src/llm/agentLoop.ts(2512,9): error TS2345: Argument of type 'Anthropic.MessageCreateParams' is not assignable to parameter of type 'MessageCreateParamsNonStreaming'.
  Property 'stream' is missing in type 'Anthropic.MessageCreateParams' but required in type '{ stream: false; }'.
src/llm/anthropicAdapter/convertParams.ts(98,5): error TS2322: Type 'number | undefined' is not assignable to type 'number'.
  Type 'undefined' is not assignable to type 'number'.
src/core/runLlmPatchFlow.ts(445,7): error TS2531: Object is possibly 'null'.

npm ERR! Lifecycle script \`build\` failed with error:
npm ERR! Error: command failed
npm ERR!   in workspace: zone@0.0.1
npm ERR!   at location: /home/bedo/zone`.padEnd(2_500, " ").slice(0, 2_500);

// ── History builder ───────────────────────────────────────────────────────────
function buildHistory(nTurns) {
  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content:
        "The TypeScript build is failing. Run npm run build, identify the errors, and fix them. Start with src/api/server.ts.",
    },
  ];

  for (let t = 1; t <= nTurns; t++) {
    const callId = `call_build_t${t}`;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: "run_command",
            arguments: JSON.stringify({ command: "npm run build", workingDir: "." }),
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: callId,
      content: BUILD_ERROR,
    });
  }

  return messages;
}

// ── ProcessorContext stub ─────────────────────────────────────────────────────
function makeCtx(iter) {
  return {
    iter,
    runId: "probe-run",
    toolCallLog: [],
    pollingState: new Map(),
    emit: () => {},
  };
}

// ── Cost formula (Fix #1) ─────────────────────────────────────────────────────
// input_tokens EXCLUDES cache_read and cache_creation — they are separate buckets.
// Total = input_tokens + cache_read + cache_creation ≈ ctx_tok
function computeCost(usage) {
  const inUnc = usage.input_tokens ?? 0;
  const cw = usage.cache_creation_input_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const cost =
    inUnc * 3e-6 +
    cw * 3.75e-6 +
    cr * 0.30e-6 +
    out * 15e-6;
  return { inUnc, cw, cr, out, cost };
}

// ── A/B confound check (Fix #2) ───────────────────────────────────────────────
// At turn 1, both OFF and ON should produce byte-identical results.
function confoundCheck(offMsgs, onMsgs) {
  const offStr = JSON.stringify(offMsgs);
  const onStr = JSON.stringify(onMsgs);
  if (offStr !== onStr) {
    console.error("\n[CONFOUND FAIL] Turn-1 OFF and ON pipeline outputs differ!");
    console.error("R2ShimProcessor is transforming something beyond dedupe.");
    console.error("OFF length:", offStr.length, "ON length:", onStr.length);
    // Find first difference
    for (let i = 0; i < Math.min(offStr.length, onStr.length); i++) {
      if (offStr[i] !== onStr[i]) {
        console.error(`First diff at char ${i}:`, offStr.slice(Math.max(0, i-30), i+50));
        break;
      }
    }
    process.exit(1);
  }
  console.log("[confound-check] PASS — turn-1 OFF ≡ ON (byte-identical). All turn-2+ deltas are purely dedupe.");
}

// ── Pre-run cost estimate ─────────────────────────────────────────────────────
function estimateCost() {
  const sysChars = SYSTEM_PROMPT.length;
  const toolsChars = ZONE_TOOLS.reduce((s, t) => {
    return s + (t.function?.name?.length ?? 0) +
      (t.function?.description?.length ?? 0) +
      JSON.stringify(t.function?.parameters ?? {}).length;
  }, 0);
  const prefix1Chars = sysChars + toolsChars;
  const prefix1Tok = Math.ceil(prefix1Chars / 4);

  const userSeedChars = 100;
  const assistantChars = 60; // tool_use JSON per turn
  const toolResultChars = BUILD_ERROR.length;
  const dedubeStubChars = 64;

  // OFF at turn T: prefix + T×(asst + tool_full)
  // ON at turn T: prefix + (T-1)×(asst + stub) + 1×(asst + tool_full)
  let offTotal = 0, onTotal = 0;
  for (let t = 1; t <= N_TURNS; t++) {
    const offConvChars = userSeedChars + t * (assistantChars + toolResultChars);
    const onConvChars = userSeedChars + (t - 1) * (assistantChars + dedubeStubChars) + (assistantChars + toolResultChars);

    // Turn-1 cache_write amortizes across both modes (same turn-1 content)
    // Subsequent turns: BP#1 always a cache_read (stable). BP#2 cost varies.
    const prefix1Cost = t === 1 ? prefix1Tok * 3.75e-6 : prefix1Tok * 0.30e-6;
    const offConvTok = Math.ceil(offConvChars / 4);
    const onConvTok = Math.ceil(onConvChars / 4);

    // Simplistic: conv tokens are mostly cache_write each turn (BP#2 moves forward)
    offTotal += prefix1Cost + offConvTok * 3.75e-6 + 16 * 15e-6;
    onTotal += prefix1Cost + onConvTok * 3.75e-6 + 16 * 15e-6;
  }

  console.log(`\n=== Pre-run cost estimate ===`);
  console.log(`System prompt: ~${sysChars} chars (~${prefix1Tok.toLocaleString()} tok with tools)`);
  console.log(`Build error: ~${BUILD_ERROR.length} chars (~${Math.ceil(BUILD_ERROR.length/4)} tok)`);
  console.log(`Turns: ${N_TURNS} × 2 modes = ${N_TURNS * 2} API calls`);
  console.log(`Estimated OFF total: ~$${offTotal.toFixed(4)}`);
  console.log(`Estimated ON total:  ~$${onTotal.toFixed(4)}`);
  console.log(`Estimated combined:  ~$${(offTotal + onTotal).toFixed(4)}`);
  console.log();
  return { offTotal, onTotal };
}

// ── Run one mode ──────────────────────────────────────────────────────────────
async function runMode(label, anthropic, applyPipeline) {
  const rows = [];
  process.stdout.write(`\nRunning ${label} mode (${N_TURNS} turns):`);

  for (let t = 1; t <= N_TURNS; t++) {
    const fullHistory = buildHistory(t);
    const pipelined = applyPipeline(fullHistory, t);

    // convertParams handles: system extraction, BP#1, BP#2
    const { params: anthropicParams } = convertParams(
      {
        model: MODEL,
        messages: pipelined,
        tools: ZONE_TOOLS,
        tool_choice: "auto",
        max_tokens: MAX_TOKENS,
        stream: false,
      },
      {}
    );

    const response = await anthropic.messages.create({
      ...anthropicParams,
      stream: false,
    });

    const u = response.usage;
    const { inUnc, cw, cr, out, cost } = computeCost(u);
    const ctxTok = inUnc + cw + cr;

    rows.push({ t, inUnc, cw, cr, out, ctxTok, cost });
    process.stdout.write(` ${t}`);
  }

  console.log(" done");
  return rows;
}

// ── Table printer ─────────────────────────────────────────────────────────────
function printTable(label, rows) {
  console.log(`\n=== ${label} ===`);
  console.log(
    "turn │ in_unc  │ c_write │ c_read  │ output │ ctx_tok │    cost($)"
  );
  console.log("─────┼─────────┼─────────┼─────────┼────────┼─────────┼───────────");
  let totalCost = 0;
  for (const r of rows) {
    totalCost += r.cost;
    console.log(
      `  ${String(r.t).padStart(2)} │ ${String(r.inUnc).padStart(7)} │ ${String(r.cw).padStart(7)} │ ${String(r.cr).padStart(7)} │ ${String(r.out).padStart(6)} │ ${String(r.ctxTok).padStart(7)} │ ${r.cost.toFixed(6)}`
    );
  }
  console.log("─────┼─────────┼─────────┼─────────┼────────┼─────────┼───────────");
  console.log(`TOTAL │         │         │         │        │         │ ${totalCost.toFixed(6)}`);
  return totalCost;
}

// ── Sanity check ─────────────────────────────────────────────────────────────
function sanityCheck(rows, label) {
  console.log(`\n=== Sanity check: ctx_tok growth (${label}) ===`);
  let prevCtx = 0;
  let ok = true;
  for (const r of rows) {
    const delta = r.ctxTok - prevCtx;
    const flag = delta < 0 ? " ← NEGATIVE DELTA?" : "";
    console.log(`  t=${r.t}: ctx_tok=${r.ctxTok} (Δ${delta >= 0 ? "+" : ""}${delta})${flag}`);
    if (delta < 0 && r.t > 1) ok = false;
    prevCtx = r.ctxTok;
  }
  if (!ok) {
    console.error("[SANITY FAIL] ctx_tok decreased between turns — accounting may be wrong.");
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== dedupe-cache-probe ===");
  console.log(`Model: ${MODEL} | Turns: ${N_TURNS} | max_tokens: ${MAX_TOKENS}`);

  const apiKey = loadApiKey();
  const anthropic = new Anthropic({ apiKey, maxRetries: 0 });

  estimateCost();

  // ── OFF pipeline: pruneStaleReads only (no dedupe) ────────────────────────
  const offPipeline = (messages, _t) => {
    const { pruned } = pruneStaleReads(messages, 2);
    return pruned;
  };

  // ── ON pipeline: R2ShimProcessor (pruneStaleReads + dedupeToolOutputs) ───
  // Single stateful instance persists across all turns (mirrors production).
  const shimProc = new R2ShimProcessor({ kind: "r2_shim", freshIterWindow: 2, useU1CacheAwareShim: true });
  const onPipeline = (messages, t) => {
    const ctx = makeCtx(t - 1); // iter is 0-indexed in production
    const result = shimProc.process(messages, ctx);
    return result.kind === "transformed" ? result.messages : messages;
  };

  // ── Fix #2: confound check on turn 1 ─────────────────────────────────────
  {
    const t1History = buildHistory(1);
    const offT1 = offPipeline([...t1History], 1);
    // Reset shim state for a clean turn-1 check (will re-process below with fresh state)
    shimProc.reset();
    const onT1 = onPipeline([...t1History], 1);
    confoundCheck(offT1, onT1);
    // Reset shim so it starts fresh for the actual ON run
    shimProc.reset();
  }

  // ── OFF run ───────────────────────────────────────────────────────────────
  const offRows = await runMode("OFF (pruneStaleReads only)", anthropic, offPipeline);

  // ── ON run ────────────────────────────────────────────────────────────────
  // Fresh shim instance for the ON run (clean state)
  const shimProc2 = new R2ShimProcessor({ kind: "r2_shim", freshIterWindow: 2, useU1CacheAwareShim: true });
  const onPipeline2 = (messages, t) => {
    const ctx = makeCtx(t - 1);
    const result = shimProc2.process(messages, ctx);
    return result.kind === "transformed" ? result.messages : messages;
  };
  const onRows = await runMode("ON (R2ShimProcessor + dedupe)", anthropic, onPipeline2);

  // ── Tables ────────────────────────────────────────────────────────────────
  const offTotal = printTable("OFF mode (no dedupe)", offRows);
  const onTotal = printTable("ON mode (with dedupe)", onRows);

  // ── Sanity checks ─────────────────────────────────────────────────────────
  sanityCheck(offRows, "OFF");
  sanityCheck(onRows, "ON");

  // ── Comparison ────────────────────────────────────────────────────────────
  console.log("\n=== Comparison: OFF vs ON per turn ===");
  console.log("turn │ c_write_OFF │ c_write_ON │ c_read_OFF │ c_read_ON │ cost_OFF($) │ cost_ON($) │ delta($)");
  console.log("─────┼─────────────┼────────────┼────────────┼───────────┼────────────┼────────────┼─────────");

  let totalDelta = 0;
  for (let i = 0; i < N_TURNS; i++) {
    const off = offRows[i];
    const on = onRows[i];
    const delta = on.cost - off.cost;
    totalDelta += delta;
    console.log(
      `  ${String(off.t).padStart(2)} │ ${String(off.cw).padStart(11)} │ ${String(on.cw).padStart(10)} │ ${String(off.cr).padStart(10)} │ ${String(on.cr).padStart(9)} │ ${off.cost.toFixed(6)} │ ${on.cost.toFixed(6)} │ ${delta >= 0 ? "+" : ""}${delta.toFixed(6)}`
    );
  }
  console.log("─────┼─────────────┼────────────┼────────────┼───────────┼────────────┼────────────┼─────────");
  console.log(
    `TOTAL│             │            │            │           │ ${offTotal.toFixed(6)} │ ${onTotal.toFixed(6)} │ ${totalDelta >= 0 ? "+" : ""}${totalDelta.toFixed(6)}`
  );

  const pctDelta = offTotal > 0 ? ((onTotal - offTotal) / offTotal) * 100 : 0;
  console.log(`\nNet delta: ${totalDelta >= 0 ? "+" : ""}$${totalDelta.toFixed(6)} (${pctDelta >= 0 ? "+" : ""}${pctDelta.toFixed(1)}% vs OFF baseline)`);

  // ── cache_write inflation check ───────────────────────────────────────────
  const maxOffCw = Math.max(...offRows.map((r) => r.cw));
  const maxOnCw = Math.max(...onRows.map((r) => r.cw));
  const cwInflation = maxOnCw - maxOffCw;

  console.log(`\n=== cache_write inflation check ===`);
  console.log(`Max c_write OFF: ${maxOffCw} tok`);
  console.log(`Max c_write ON:  ${maxOnCw} tok`);
  console.log(`Inflation:       ${cwInflation >= 0 ? "+" : ""}${cwInflation} tok`);

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log("\n=== MERGE VERDICT ===");

  const netCostDown = onTotal < offTotal;
  // "materially inflated" = ON c_write exceeds OFF c_write by >10% of the total OFF c_write sum
  const totalOffCw = offRows.reduce((s, r) => s + r.cw, 0);
  const totalOnCw = onRows.reduce((s, r) => s + r.cw, 0);
  const cwInflationRatio = totalOffCw > 0 ? (totalOnCw - totalOffCw) / totalOffCw : 0;
  const cwMateriallyInflated = cwInflationRatio > 0.10; // >10% more writes overall

  if (netCostDown && !cwMateriallyInflated) {
    console.log("✓ MERGE: ON shows net cost DOWN and cache_write NOT materially inflated.");
    console.log(`  Cost reduction: ${Math.abs(pctDelta).toFixed(1)}%`);
    console.log(`  cache_write delta: ${cwInflationRatio >= 0 ? "+" : ""}${(cwInflationRatio * 100).toFixed(1)}% (within tolerance)`);
  } else if (!netCostDown) {
    console.log("✗ DO NOT MERGE: ON does NOT show net cost reduction.");
    console.log(`  ON is ${Math.abs(pctDelta).toFixed(1)}% MORE expensive than OFF.`);
    if (cwMateriallyInflated) {
      console.log(`  Additionally, cache_write inflation (+${(cwInflationRatio * 100).toFixed(1)}%) erases cache_read savings.`);
    }
  } else {
    console.log("✗ DO NOT MERGE: cache_write inflation erases cache_read savings.");
    console.log(`  cache_write increased by ${(cwInflationRatio * 100).toFixed(1)}% which negates the read savings.`);
  }

  console.log(`\nTotal OFF: $${offTotal.toFixed(6)} | Total ON: $${onTotal.toFixed(6)} | Delta: $${totalDelta.toFixed(6)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
