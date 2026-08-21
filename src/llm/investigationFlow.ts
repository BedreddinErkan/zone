import { renderChatMarkdownToHtml } from "./renderChatMarkdown.js";
import { runAgentLoop } from "./agentLoop.js";
import { EXPLORE_ALLOWED_TOOLS, computeExploreMaxIterations } from "./subagents.js";
import type { Capability } from "../tools/capabilities.js";
import type { ToolResult } from "../tools/toolExecutor.js";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";
import type { LLMProvider } from "./types.js";
import { debugLog, log } from "../utils/logger.js";

const MAX_FINAL_ANSWER_CHARS = 100_000;

/**
 * Step C: Extracts structured fields from the INVESTIGATION_OUTPUT_FORMAT JSON
 * block appended by Phase 1. Never throws — returns {} on any parse failure.
 */
export function extractPhase1Findings(summary: string): {
  rootCause?: string;
  fixInstruction?: string;
  filesToEdit?: string[];
  evidence?: string;
  complete?: boolean;
} {
  try {
    const blocks = [...summary.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
    if (blocks.length === 0) return {};
    const inner = blocks[blocks.length - 1]![1] ?? "";
    const parsed: unknown = JSON.parse(inner);
    if (typeof parsed !== "object" || parsed === null) return {};
    const p = parsed as Record<string, unknown>;
    return {
      ...(typeof p["rootCause"] === "string" ? { rootCause: p["rootCause"] } : {}),
      ...(typeof p["fixInstruction"] === "string" ? { fixInstruction: p["fixInstruction"] } : {}),
      ...(Array.isArray(p["filesToEdit"]) && (p["filesToEdit"] as unknown[]).every((f) => typeof f === "string")
        ? { filesToEdit: p["filesToEdit"] as string[] }
        : {}),
      ...(typeof p["evidence"] === "string" ? { evidence: p["evidence"] } : {}),
      ...(typeof p["complete"] === "boolean" ? { complete: p["complete"] } : {}),
    };
  } catch {
    return {};
  }
}

function countCitations(text: string): number {
  const matches = text.match(/`[^`]+\.[a-z]+(?::\d+)?`/g) ?? [];
  const distinct = new Set(matches.map((m) => m.replace(/:\d+`$/, "`")));
  return distinct.size;
}

export type InvestigationFlowResult = {
  ok: true;
  decisionMode: "investigation";
  finalState?: "max_iterations" | "token_budget_exceeded" | "compaction_exhausted";
  chatResponse: string;
  responseHtml: string;
  contextFiles: string[];
  applyPatches: [];
  fileDiffs: [];
  toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>;
  costUsd: number;
};

function filePathFromToolArgs(name: string, args: Record<string, unknown>): string {
  if (name === "read_file" && typeof args.filePath === "string") return args.filePath;
  if (name === "find_references" && typeof args.sourceFile === "string") return args.sourceFile;
  return "";
}

export async function runInvestigationFlow(input: {
  task: string;
  repoPath: string;
  mode?: "investigate";
  runId?: string;
  userId?: string;
  userApiKey?: string;
  /** Provider to use for the investigation (inherits from the caller's active config). */
  provider?: LLMProvider;
  abortSignal?: AbortSignal;
  suppressOutputFormat?: boolean;
  onProgress?: (update: {
    stage: string;
    lifecycle?: unknown;
    progress?: Partial<ZoneStructuredProgressEvent>;
  }) => void;
}): Promise<InvestigationFlowResult> {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  const contextFiles = new Set<string>();

  const emitStructuredProgress = (
    progress: Partial<ZoneStructuredProgressEvent>
  ): void => {
    if (!runId) return;
    input.onProgress?.({
      stage: "investigation",
      progress: {
        runId,
        ts: Date.now(),
        ...progress,
      } as Partial<ZoneStructuredProgressEvent>,
    });
  };

  if (runId) {
    emitStructuredProgress({
      type: "agent_loop_start",
      title: "Starting investigation",
      status: "active",
    });
  }

  // Phase H.6: investigation flow has no upstream plan, so steps default to 1
  // (yields the EXPLORE_ITER_FLOOR of 15 — bumped from prior static 8).
  const planStepsCount = 1;
  const computedMax = computeExploreMaxIterations(planStepsCount);
  debugLog("[zone-iter-budget]", {
    mode: input.mode ?? "investigation",
    planStepsCount,
    computedMax,
    source: "floor-default",
  });

  debugLog("[zone-investigation-flow]", {
    stage: "start",
    runId: runId || null,
    taskPreview: String(input.task || "").slice(0, 160),
    allowedTools: [...EXPLORE_ALLOWED_TOOLS],
    maxIterations: computedMax,
  });

  const loop = await runAgentLoop({
    task: input.task,
    repoPath: input.repoPath,
    runId: runId || undefined,
    userId: input.userId,
    userApiKey: input.userApiKey,
    provider: input.provider,
    abortSignal: input.abortSignal,
    suppressOutputFormat: input.suppressOutputFormat,
    mode: "investigation",
    capabilityFilter: { allow: new Set<Capability>(["fs.read"]) },
    maxIterationsOverride: computedMax,
    onProgress: (msg: string) => {
      // [tool] lines are handled by onToolCall (structured). Skip raw duplicates.
      if (String(msg || "").startsWith("[tool]")) return;
      emitStructuredProgress({
        type: "tool_call",
        title: String(msg || "").slice(0, 200),
        status: "active",
      });
    },
    onToolCall: (name: string, args: Record<string, unknown>) => {
      const fp = filePathFromToolArgs(name, args);
      if (fp) contextFiles.add(fp);
      const suffix =
        name === "search_in_files"
          ? String(args.pattern ?? "")
          : name === "find_references"
            ? String(args.symbolName ?? "")
            : fp;
      emitStructuredProgress({
        type: "tool_call",
        title: `[tool] ${name}${suffix ? `: ${suffix}` : ""}`.slice(0, 240),
        status: "active",
      });
      debugLog("[zone-investigation-tool-call]", {
        runId: runId || null,
        tool: name,
        args,
      });
    },
    onToolResult: (name: string, result: ToolResult) => {
      emitStructuredProgress({
        type: "tool_result",
        title: String(result.output || "").slice(0, 100) || "tool result",
        detail: String(result.output || "").slice(0, 4000),
        status: result.success ? "success" : "error",
      });
      debugLog("[zone-investigation-tool-result]", {
        runId: runId || null,
        tool: name,
        success: result.success,
        outputPreview: String(result.output || "").slice(0, 300),
      });
    },
    onStructuredEvent: (evt: unknown) => {
      if (!evt || typeof evt !== "object") return;
      const e = evt as Record<string, unknown>;
      if (e.type === "narration") {
        emitStructuredProgress({
          type: "narration",
          title: String(e.title || "").slice(0, 200),
          text: String(e.text || "").slice(0, 2000),
          iter: typeof e.iter === "number" ? e.iter : undefined,
          status: "active",
        } as Partial<ZoneStructuredProgressEvent>);
      }
      if (e.type === "iter_cost_update") {
        emitStructuredProgress({
          type: "iter_cost_update",
          title: String(e.title || "Iteration cost"),
          status: "active",
          ...e,
        } as Partial<ZoneStructuredProgressEvent>);
      }
      if (e.type === "token_budget_status") {
        emitStructuredProgress({
          type: "token_budget_status",
          title: String(e.title || "Token budget"),
          status:
            (e.status as "active" | "warning" | "error" | "success" | undefined) ??
            "active",
          cumulativeTokens: typeof e.cumulativeTokens === "number" ? e.cumulativeTokens : undefined,
          tokenBudgetCap: typeof e.tokenBudgetCap === "number" ? e.tokenBudgetCap : undefined,
          tokenBudgetRatio: typeof e.tokenBudgetRatio === "number" ? e.tokenBudgetRatio : undefined,
          breakdown:
            e.breakdown && typeof e.breakdown === "object"
              ? (e.breakdown as { mainAgent?: number; subagents?: number })
              : undefined,
          iter: typeof e.iter === "number" ? e.iter : undefined,
        } as Partial<ZoneStructuredProgressEvent>);
      }
      if (e.type === "compaction_status") {
        emitStructuredProgress({
          type: "compaction_status" as any,
          title: "Compacting context",
          status: "active",
          count: typeof e.count === "number" ? e.count : 0,
        } as any);
      }
      if (e.type === "compaction_exhausted") {
        emitStructuredProgress({
          type: "compaction_exhausted" as any,
          title: "Context exhausted",
          status: "warning",
          message: String(e.message || ""),
        } as any);
      }
    },
  });

  const terminationReason = loop.terminationReason;
  const hitCompactionExhausted = terminationReason === "compaction_exhausted";
  const hitTokenBudget = terminationReason === "token_budget_exceeded";
  const hitRunUsdCap = terminationReason === "run_usd_cap_exceeded";
  const hitMaxIter =
    terminationReason === "max_iterations" ||
    // The fallback arm catches "failed for some other reason" — but a budget stop is a named
    // reason, and letting it fall in here would label a --max-budget-usd exit "max iterations".
    (!loop.success && !hitTokenBudget && !hitCompactionExhausted && !hitRunUsdCap);
  const responseText = String(loop.summary || "").trim() || "I could not produce an investigation answer.";
  emitStructuredProgress({
    type: "agent_loop_complete",
    title: loop.success
      ? "Investigation complete"
      : hitCompactionExhausted
        ? "Investigation aborted — context exhausted"
        : hitTokenBudget
          ? "Investigation ended at token budget"
          : hitRunUsdCap
            ? "Investigation stopped at the run budget"
            : "Investigation ended with partial findings",
    detail: responseText.slice(0, MAX_FINAL_ANSWER_CHARS),
    status: loop.success ? "success" : "warning",
  });

  const finalState: InvestigationFlowResult["finalState"] = hitCompactionExhausted
    ? "compaction_exhausted"
    : hitTokenBudget
      ? "token_budget_exceeded"
      : hitMaxIter
        ? "max_iterations"
        : undefined;

  const citationCount = countCitations(responseText);
  log("[zone-investigation-summary]", JSON.stringify({
    event: "investigation_summary",
    runId: runId || null,
    toolCallCount: loop.toolCallLog.length,
    totalCostUsd: loop.costUsd ?? 0,
    citationCount,
    query: String(input.task || "").slice(0, 100),
    finalState: finalState ?? "success",
    ts: new Date().toISOString(),
  }));

  return {
    ok: true,
    decisionMode: "investigation",
    ...(finalState ? { finalState } : {}),
    chatResponse: responseText,
    responseHtml: renderChatMarkdownToHtml(responseText),
    contextFiles: [...contextFiles].slice(0, 20),
    applyPatches: [],
    fileDiffs: [],
    toolCallLog: loop.toolCallLog,
    costUsd: loop.costUsd ?? 0,
  };
}

