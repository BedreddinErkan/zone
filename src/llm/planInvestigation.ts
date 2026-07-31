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

/** Maximum files passed to the investigation prompt. Matches QUICK_PLAN_FILES. */
export const PLAN_INVESTIGATION_MAX_FILES = 5;

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
If the TASK itself is a question — not a request to change anything — and steps 1-2
found nothing that needs to change, set answerOnlyReason and use steps:[] instead of
fabricating a change nobody asked for.` : ""}
3. Produce the ExecutionPlan JSON in a \`\`\`json block as your FINAL message.

JSON shape:
{
  "objective": "string",
  "steps": [
    {
      "title": "string",
      "description": "<short approach: what this step does to which code + the key decision/edit, 1-3 sentences, concrete, not a restatement of the title>",
      "filesLikely": ["string"],
      "subagentEligible": true | false,
      "subagentType": "worker" | "explore"
    }
  ],
  "riskHints": ["string"],
  "scopeSummary": "string (≤160 chars)",
  "scopeNotes": "string (optional, ≤200 chars — what is already done / out of scope)",
  "noChangeReason": "string (optional — set when reproduce command ran and exited 0; steps MUST be [])",
  "cannotVerifyReason": "string (optional — set when reproduce command did NOT run; steps MUST be [])"${allowAnswerOnly ? `,
  "answerOnlyReason": "string (optional — set when the task is a question and the investigation found nothing that needs to change; steps MUST be [])"` : ""}
}

Rules:
- filesLikely: copy paths VERBATIM from the files you read. Never invent or alter extensions.
- scopeNotes: populate if you observed already-implemented or out-of-scope work; omit if nothing notable.
- noChangeReason: if you ran the reproduce step and exit_code=0, set this and use steps:[]. Never fabricate steps for a problem that did not reproduce.
- cannotVerifyReason: mutually exclusive with noChangeReason. Set only when the reproduce command did not run even bare. Do NOT set this to avoid investigation — only for genuine infrastructure blocks.${allowAnswerOnly ? `
- answerOnlyReason: mutually exclusive with the other two. Set only when the TASK asked a question and the investigation found nothing requiring a code change — not for a claimed bug that didn't reproduce (that's noChangeReason) and not for a blocked reproduce attempt (that's cannotVerifyReason).` : ""}
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
    capabilityFilter: { allowToolNames: new Set(INVESTIGATION_TOOLS) },
    maxIterationsOverride: PLAN_INVESTIGATION_ITER_CAP,
    onToolCall: (name: string, args: Record<string, unknown>) => {
      const fp =
        name === "read_file" && typeof args["filePath"] === "string"
          ? args["filePath"]
          : name === "find_references" && typeof args["sourceFile"] === "string"
            ? args["sourceFile"]
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

  log("[zone-plan-investigation-complete]", JSON.stringify({
    runId: runId || null,
    iterCount: loop.iterCount ?? 0,
    tokensUsed: loop.tokenUsage?.total ?? 0,
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
