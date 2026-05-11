import { renderChatMarkdownToHtml } from "./renderChatMarkdown.js";
import { runAgentLoop } from "./agentLoop.js";
import { EXPLORE_ALLOWED_TOOLS, computeExploreMaxIterations } from "./subagents.js";
import { CHAT_TOOLS } from "../tools/toolDefinitions.js";
import type { ToolResult } from "../tools/toolExecutor.js";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";
import { debugLog } from "../utils/logger.js";

export type InvestigationFlowResult = {
  ok: true;
  decisionMode: "investigation";
  finalState?: "max_iterations" | "token_budget_exceeded";
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
};

export type ChatAgentFlowResult = {
  ok: true;
  decisionMode: "chat";
  finalState?: "max_iterations" | "token_budget_exceeded";
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
  abortSignal?: AbortSignal;
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
    abortSignal: input.abortSignal,
    mode: "investigation",
    allowedTools: EXPLORE_ALLOWED_TOOLS,
    maxIterationsOverride: computedMax,
    disableTodoWrite: true,
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
    },
  });

  const terminationReason = loop.terminationReason;
  const hitTokenBudget = terminationReason === "token_budget_exceeded";
  const hitMaxIter =
    terminationReason === "max_iterations" || (!loop.success && !hitTokenBudget);
  const responseText = String(loop.summary || "").trim() || "I could not produce an investigation answer.";
  emitStructuredProgress({
    type: "agent_loop_complete",
    title: loop.success
      ? "Investigation complete"
      : hitTokenBudget
        ? "Investigation ended at token budget"
        : "Investigation ended with partial findings",
    detail: responseText.slice(0, 4000),
    status: loop.success ? "success" : "warning",
  });

  const finalState: InvestigationFlowResult["finalState"] = hitTokenBudget
    ? "token_budget_exceeded"
    : hitMaxIter
      ? "max_iterations"
      : undefined;

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
  };
}

export async function runChatAgentFlow(input: {
  task: string;
  repoPath: string;
  runId?: string;
  userId?: string;
  userApiKey?: string;
  abortSignal?: AbortSignal;
  onProgress?: (update: {
    stage: string;
    lifecycle?: unknown;
    progress?: Partial<ZoneStructuredProgressEvent>;
  }) => void;
}): Promise<ChatAgentFlowResult> {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  const contextFiles = new Set<string>();
  const allowedTools: ReadonlySet<string> = new Set(CHAT_TOOLS);

  const emitStructuredProgress = (
    progress: Partial<ZoneStructuredProgressEvent>
  ): void => {
    if (!runId) return;
    input.onProgress?.({
      stage: "chat_response",
      progress: {
        runId,
        ts: Date.now(),
        ...progress,
      } as Partial<ZoneStructuredProgressEvent>,
    });
  };

  if (runId) {
    emitStructuredProgress({
      type: "chat_start",
      title: "Thinking...",
      status: "active",
    } as Partial<ZoneStructuredProgressEvent>);
  }

  const loop = await runAgentLoop({
    task: input.task,
    repoPath: input.repoPath,
    runId: runId || undefined,
    userId: input.userId,
    userApiKey: input.userApiKey,
    abortSignal: input.abortSignal,
    mode: "chat",
    allowedTools,
    maxIterationsOverride: 6,
    disableTodoWrite: true,
    onToolCall: (name: string, args: Record<string, unknown>) => {
      const fp = filePathFromToolArgs(name, args);
      if (fp) contextFiles.add(fp);
      emitStructuredProgress({
        type: "tool_call",
        title: `[tool] ${name}${fp ? `: ${fp}` : ""}`.slice(0, 240),
        status: "active",
      });
    },
    onToolResult: (_name: string, result: ToolResult) => {
      emitStructuredProgress({
        type: "tool_result",
        title: String(result.output || "").slice(0, 100) || "tool result",
        detail: String(result.output || "").slice(0, 4000),
        status: result.success ? "success" : "error",
      });
    },
    onStructuredEvent: (evt: unknown) => {
      if (!evt || typeof evt !== "object") return;
      const e = evt as Record<string, unknown>;
      if (e.type === "iter_cost_update" || e.type === "token_budget_status") {
        emitStructuredProgress({
          type: e.type as ZoneStructuredProgressEvent["type"],
          title: String(e.title || "Run update"),
          status:
            (e.status as "active" | "warning" | "error" | "success" | undefined) ??
            "active",
          ...e,
        } as Partial<ZoneStructuredProgressEvent>);
      }
    },
  });

  const terminationReason = loop.terminationReason;
  const finalState: ChatAgentFlowResult["finalState"] =
    terminationReason === "token_budget_exceeded"
      ? "token_budget_exceeded"
      : terminationReason === "max_iterations"
        ? "max_iterations"
        : undefined;
  const responseText = String(loop.summary || "").trim() || "I could not produce a response.";

  emitStructuredProgress({
    type: "chat_done",
    title: "Response ready",
    status: loop.success ? "success" : "warning",
    responseText,
    responseHtml: renderChatMarkdownToHtml(responseText),
    contextFiles: [...contextFiles].slice(0, 20),
  } as Partial<ZoneStructuredProgressEvent>);

  return {
    ok: true,
    decisionMode: "chat",
    ...(finalState ? { finalState } : {}),
    chatResponse: responseText,
    responseHtml: renderChatMarkdownToHtml(responseText),
    contextFiles: [...contextFiles].slice(0, 20),
    applyPatches: [],
    fileDiffs: [],
    toolCallLog: loop.toolCallLog,
  };
}
