import { readFile } from "node:fs/promises";
import { runAgentLoop } from "./agentLoop.js";
import { PlanRefusalError } from "./factory.js";
import { INVESTIGATION_TOOLS } from "../tools/toolDefinitions.js";
import {
  generateExecutionPlan,
  tryParseExecutionPlan,
  type ExecutionPlan,
} from "./executionPlan.js";
import type {
  LlmPatchProgressUpdate,
  ZoneStructuredProgressEvent,
} from "../core/agentLifecycleEvents.js";
import type { ToolResult } from "../tools/toolExecutor.js";
import type { LLMProvider } from "./types.js";
import { log } from "../utils/logger.js";

/** Hard iteration cap for plan investigation. Primary cost lever.
 *  runAgentLoop supports multiple tool calls per iteration (batched tool_calls
 *  array), so batched reads of 5 files take 2–3 iters. Empirically a 5-file
 *  task with search ran 5 natural iters; 6 provides headroom for natural
 *  completion while bounding worst-case cost. The maxIterationsOverride fix
 *  in agentLoop.ts ensures this cap is honored even with tier defaults. */
export const PLAN_INVESTIGATION_ITER_CAP = 6;

/** Maximum files passed to the investigation prompt. Set to cover the full
 *  ranked+grep merge from preparePlanContext (5 ranked + up to 4 grep extras,
 *  9 total) rather than QUICK_PLAN_FILES' contents-budget value — the two no
 *  longer match. Below 9, a grep-only match (present in the merge but past
 *  the old width-5 slice) never reaches this prompt at all. See
 *  docs/deferred-work.md item 79. */
export const PLAN_INVESTIGATION_MAX_FILES = 9;

// Fallback seeding caps — same as Option B (dispatch.ts QUICK_PLAN_* constants).
const FALLBACK_FILE_CAP = 3_000;
const FALLBACK_TOTAL_CAP = 12_000;

export interface PlanInvestigationInput {
  task: string;
  repoPath: string;
  runId: string;
  /** Ranked file paths from preparePlanContext. Sliced to PLAN_INVESTIGATION_MAX_FILES internally. */
  relevantFiles: string[];
  /** projectSummary from preparePlanContext — used in fallback only. */
  repoSummary: string;
  userApiKey?: string;
  provider?: LLMProvider;
  abortSignal?: AbortSignal;
  /** Passed directly from dispatch.ts — routes to TUI bus via index.tsx. */
  progressCallback: (update: LlmPatchProgressUpdate) => void;
}

/**
 * Exported for direct testing of prompt content.
 *
 * allowAnswerOnly has no default — shape-permission is a caller decision, not
 * something this function should assume. The one call site (runPlanInvestigation,
 * below) passes `true` explicitly; a future second caller must make its own choice
 * rather than silently inheriting this one's.
 */
export function buildPrompt(task: string, relevantFiles: string[], allowAnswerOnly: boolean): string {
  const fileList = relevantFiles.length > 0 ? relevantFiles.join("\n") : "(none)";
  return `You are planning a coding task. Read the listed files, then output a JSON ExecutionPlan.

TASK: ${task}

RELEVANT FILES (read these; follow imports only if critical to understanding):
${fileList}

Instructions:
NOTE: If the TASK uses an additive or structural lead verb — add, create, implement,
build, scaffold, introduce, generate, write, set up, make, new, refactor, rename,
extract, migrate, convert — skip step 0 entirely and proceed directly to steps 1-2.
Produce concrete implementation steps; do NOT set noChangeReason or cannotVerifyReason.
There is no pre-existing problem to reproduce.

0. If TASK asserts a problem ("fix the error in X", "build fails", "why does X fail"):
   a. Run the relevant command BARE (e.g. npm run build, npx tsc --noEmit) — no 2>&1 or pipes
      (output is captured automatically; metachars block auto-approval).
   b. If it does not run: re-run it bare (drop any 2>&1/pipe/redirect). If still blocked: STOP —
      set cannotVerifyReason and use steps:[]. Do NOT read files to guess a fix.
   c. If exit_code=0: set noChangeReason and use steps:[].
   d. If exit_code≠0: read the error output, then proceed to steps 1-2 below.
   Steps 1-2 (read/search) apply ONLY after you have observed the error in step (d),
   OR directly when the TASK does not assert a runtime problem (nothing to reproduce).
1. Use read_file to examine each listed file.
2. Note what is already implemented or clearly out of scope for this task.${allowAnswerOnly ? `
If steps 1-2 concluded the current behavior is correct and deliberate — nothing is broken
and no code change is warranted — set answerOnlyReason and use steps:[] instead of
fabricating a change nobody needs. Judge this on what you FOUND, not on how the TASK was
phrased: a question can still need real steps, and if you found something that should
change, produce steps regardless of phrasing.` : ""}
3. Produce the ExecutionPlan JSON in a \`\`\`json block as your FINAL message.

JSON shape:
{
  "narrative": "string — the plan itself, in markdown. Choose your own sections: write what this particular task needs and nothing it does not. A one-file fix does not need the same structure as a multi-commit refactor.",
  "filesLikely": ["string"],
  "steps": [
    {
      "title": "string",
      "description": "<what this step does to which code + the key decision/edit, concrete, not a restatement of the title>",
      "filesLikely": ["string"],
      "subagentEligible": true | false,
      "subagentType": "worker" | "explore"
    }
  ],
  "requestedTools": ["string"] (optional — name tools you were not offered but need, by exact name),
  "noChangeReason": "string (optional — set when reproduce command ran and exited 0; steps MUST be [])",
  "cannotVerifyReason": "string (optional — set when reproduce command did NOT run; steps MUST be [])"${allowAnswerOnly ? `,
  "answerOnlyReason": "string (optional — set when the investigation concluded the current behavior is correct and deliberate and no code change is warranted; steps MUST be [])"` : ""}
}

Rules:
- narrative: this is what the user reads and approves. filesLikely and steps are read by the tooling and are not displayed beside it — do not repeat their contents as prose sections. Write the narrative as though the reader can see only it.
- filesLikely: every file this plan will create or modify, paths verbatim from the files you read. Never invent or alter extensions. It is the write guard's input, not a reading list — list only files you intend to change.
- steps: still used for delegation and iteration budgeting; omit or leave empty when the work has no natural step decomposition.
- subagentEligible/subagentType: decide this per step, after the plan's steps are already decided — do not restructure steps around the marking decision. Mark subagentEligible: true with subagentType: "worker" ONLY for independent multi-file edits — the same transformation applied across 3+ files (rename across files, repeated find-replace, codemods). NOT for a single-file edit, even if complex. Mark subagentType: "explore" ONLY for pure read-only investigation that doesn't depend on parent context ("list every caller of X", "map files matching Y"). NOT for a trivial lookup you can do in one read. Example: renaming an identifier across 5 files → mark worker; mapping every caller of a function across the codebase → mark explore; adding one JSDoc comment to one file → omit the annotation entirely.
- requestedTools: name tools you were not offered but genuinely need, by exact name — only when the tool-absence notice told you they're withheld. Do not invent tool names.
- noChangeReason: if you ran the reproduce step and exit_code=0, set this and use steps:[]. Never fabricate steps for a problem that did not reproduce.
- cannotVerifyReason: mutually exclusive with noChangeReason. Set only when the reproduce command did not run even bare. Do NOT set this to avoid investigation — only for genuine infrastructure blocks.${allowAnswerOnly ? `
- answerOnlyReason: mutually exclusive with the other two. Set ONLY when the investigation concluded the existing behavior is correct and deliberate and no code change is warranted — judged on findings, never on the task's phrasing. If the investigation found a real defect, produce steps even if the task was phrased as a question. Not for a claimed bug that didn't reproduce (that's noChangeReason) and not for a blocked reproduce attempt (that's cannotVerifyReason).` : ""}
- Terminate as soon as you have enough information to write the plan — do not over-investigate.
- Your final turn MUST contain the \`\`\`json block.`.trim();
}

/**
 * Phase 2b: bounded read-only investigation that produces an ExecutionPlan.
 * Thin wrapper over runAgentLoop (investigation mode) with a hard 4-iter cap.
 * Streams tool_call / tool_result / narration events to the TUI via progressCallback.
 * Falls back to content-aware generateExecutionPlan if JSON parse fails.
 *
 * Must be called inside withRequestContext(planGenCtx, ...) so the Phase 2a
 * model-override fix (getModelName("high", ..., requestCtx?.modelOverride))
 * selects the user's chosen model.
 */
export async function runPlanInvestigation(
  input: PlanInvestigationInput
): Promise<ExecutionPlan> {
  const { runId } = input;
  const cappedFiles = input.relevantFiles.slice(0, PLAN_INVESTIGATION_MAX_FILES);

  const emitProgress = (progress: Partial<ZoneStructuredProgressEvent>): void => {
    input.progressCallback({
      stage: progress.type ?? "plan_investigation",
      progress: { runId, ts: Date.now(), ...progress } as ZoneStructuredProgressEvent,
    });
  };

  const loop = await runAgentLoop({
    task: buildPrompt(input.task, cappedFiles, true),
    repoPath: input.repoPath,
    runId: runId || undefined,
    userApiKey: input.userApiKey,
    provider: input.provider,
    abortSignal: input.abortSignal,
    mode: "investigation",
    // Item 166 stage one: this loop's output IS the ExecutionPlan the execution
    // loop reads requestedTools from, and buildPrompt above names the field in the
    // JSON shape it hands the model — so the redirection reaches somewhere here.
    // runInvestigationFlow shares the mode and neither property; it must not set this.
    allowToolRequest: true,
    capabilityFilter: { allowToolNames: new Set(INVESTIGATION_TOOLS) },
    maxIterationsOverride: PLAN_INVESTIGATION_ITER_CAP,
    onToolCall: (name: string, args: Record<string, unknown>) => {
      const fp =
        name === "read_file" && typeof args["filePath"] === "string"
          ? args["filePath"]
          : name === "find_references" && typeof args["sourceFile"] === "string"
            ? args["sourceFile"]
            : name === "list_files" && typeof args["dirPath"] === "string"
              ? args["dirPath"]
              : name === "search_in_files" && typeof args["pattern"] === "string"
                ? args["pattern"]
                : name === "run_command" && typeof args["command"] === "string"
                  ? args["command"]
                  : "";
      emitProgress({
        type: "tool_call",
        title: `[tool] ${name}${fp ? `: ${fp}` : ""}`.slice(0, 240),
        status: "active",
      });
    },
    onToolResult: (_name: string, result: ToolResult) => {
      emitProgress({
        type: "tool_result",
        title: String(result.output || "").slice(0, 100) || "tool result",
        detail: String(result.output || "").slice(0, 4000),
        status: result.success ? "success" : "error",
      });
    },
    onStructuredEvent: (evt: unknown) => {
      if (!evt || typeof evt !== "object") return;
      const e = evt as Record<string, unknown>;
      if (e["type"] === "narration") {
        emitProgress({
          type: "narration",
          title: String(e["title"] || "").slice(0, 200),
          text: String(e["text"] || "").slice(0, 2000),
          iter: typeof e["iter"] === "number" ? e["iter"] : undefined,
          status: "active",
        } as Partial<ZoneStructuredProgressEvent>);
      }
      // agentLoop.ts populates reasoningText from either provider now: Anthropic's thinking
      // blocks (convertResponse.ts) and OpenAI's reasoning summary (responsesConvertResponse.ts,
      // requested via reasoning.summary:"auto" and extracted from the response's reasoning
      // items). This forwarder is provider-agnostic by construction — it keys on event type,
      // never on which provider produced it — so no change was needed here to close that gap.
      if (e["type"] === "thinking") {
        emitProgress({
          type: "thinking",
          text: String(e["text"] || "").slice(0, 4000),
          iter: typeof e["iter"] === "number" ? e["iter"] : undefined,
          status: "active",
        } as Partial<ZoneStructuredProgressEvent>);
      }
      if (e["type"] === "iter_cost_update") {
        emitProgress({
          type: "iter_cost_update",
          title: String(e["title"] || "Iteration cost"),
          status: "active",
          ...e,
        } as Partial<ZoneStructuredProgressEvent>);
      }
      if (e["type"] === "token_budget_status") {
        emitProgress({
          type: "token_budget_status",
          title: String(e["title"] || "Token budget"),
          status: (e["status"] as "active" | "warning" | "error" | "success" | undefined) ?? "active",
          cumulativeTokens: typeof e["cumulativeTokens"] === "number" ? e["cumulativeTokens"] : undefined,
          tokenBudgetCap: typeof e["tokenBudgetCap"] === "number" ? e["tokenBudgetCap"] : undefined,
          tokenBudgetRatio: typeof e["tokenBudgetRatio"] === "number" ? e["tokenBudgetRatio"] : undefined,
          iter: typeof e["iter"] === "number" ? e["iter"] : undefined,
        } as Partial<ZoneStructuredProgressEvent>);
      }
    },
  });

  const summaryText = String(loop.summary ?? "").trim();

  // Short-circuit on formal refusal (stop_reason:"refusal" → content_filter → loop.refusal).
  // Do NOT fall through to the generateExecutionPlan fallback — that would either fabricate a
  // plan for refused work or produce a second refusal. Cost is real (the investigation ran).
  // NOTE: a plain-text decline with stop_reason:"end_turn" (no refusal field) still falls
  // through to the fallback — acceptable, formal refusal is the primary detection case.
  if (loop.refusal != null) {
    throw new PlanRefusalError(loop.refusal, loop.costUsd ?? 0);
  }

  const plan = tryParseExecutionPlan(summaryText);

  // cachedTokens is cache-READ tokens only — SubagentTokenUsage has no cache-write
  // figure at all (not merged into cached, simply never populated), so tokensUsed
  // (input+output) and cachedTokens together still omit cache-write tokens entirely.
  // Per-token cost arithmetic from this payload is still unsound until that gap closes.
  log("[zone-plan-investigation-complete]", JSON.stringify({
    runId: runId || null,
    iterCount: loop.iterCount ?? 0,
    tokensUsed: loop.tokenUsage?.total ?? 0,
    inputTokens: loop.tokenUsage?.input ?? 0,
    outputTokens: loop.tokenUsage?.output ?? 0,
    cachedTokens: loop.tokenUsage?.cached ?? 0,
    costUsd: loop.costUsd ?? 0,
    terminationReason: loop.terminationReason ?? "success",
    fallbackUsed: !plan,
  }));

  // Synthetic post-loop cost repaint: surface investigation spend in the status bar at the
  // plan-ready modal, independent of per-iter repaint timing. handleIterCost maps this to
  // STATUS_UPDATE{costUsd}, a SET (not add) — idempotent with the per-iter iter_cost_update
  // events. Display-only (no LLM call) ⇒ no billing double-count; execution-phase updates
  // overwrite it after approval.
  emitProgress({
    type: "iter_cost_update",
    title: "Investigation cost",
    status: "active",
    cumulativeCost: loop.costUsd ?? 0,
    iter: loop.iterCount ?? 0,
  } as Partial<ZoneStructuredProgressEvent>);

  if (plan) return plan;

  // Fallback: content-aware plan-gen — at least as good as the "quick" path.
  // Read file bodies lazily (only reached when parse fails).
  const seededParts: string[] = [];
  let cumChars = 0;
  for (const fp of cappedFiles) {
    try {
      let content = await readFile(fp, "utf-8");
      if (content.length > FALLBACK_FILE_CAP) content = content.slice(0, FALLBACK_FILE_CAP);
      if (cumChars + content.length > FALLBACK_TOTAL_CAP) break;
      seededParts.push(`=== ${fp} ===\n${content}`);
      cumChars += content.length;
    } catch { /* skip unreadable */ }
  }
  const seededFileContents = seededParts.length > 0 ? seededParts.join("\n\n") : undefined;

  return generateExecutionPlan({
    task: input.task,
    repoSummary: input.repoSummary,
    relevantFiles: input.relevantFiles,
    userApiKey: input.userApiKey,
    provider: input.provider,
    seededFileContents,
  });
}
