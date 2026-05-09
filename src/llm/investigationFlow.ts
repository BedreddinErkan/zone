import { renderChatMarkdownToHtml } from "./renderChatMarkdown.js";
import { runAgentLoop } from "./agentLoop.js";
import { EXPLORE_ALLOWED_TOOLS } from "./subagents.js";
import type { ToolResult } from "../tools/toolExecutor.js";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";
import { debugLog } from "../utils/logger.js";

export type InvestigationFlowResult = {
  ok: true;
  decisionMode: "investigation";
  finalState?: "max_iterations";
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

  debugLog("[zone-investigation-flow]", {
    stage: "start",
    runId: runId || null,
    taskPreview: String(input.task || "").slice(0, 160),
    allowedTools: [...EXPLORE_ALLOWED_TOOLS],
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
    maxIterationsOverride: 8,
    disableTodoWrite: true,
    onProgress: (msg: string) => {
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
    },
  });

  const hitMaxIter = !loop.success;
  const responseText = String(loop.summary || "").trim() || "I could not produce an investigation answer.";
  emitStructuredProgress({
    type: "agent_loop_complete",
    title: loop.success ? "Investigation complete" : "Investigation ended with partial findings",
    detail: responseText.slice(0, 4000),
    status: loop.success ? "success" : "warning",
  });

  return {
    ok: true,
    decisionMode: "investigation",
    ...(hitMaxIter ? { finalState: "max_iterations" as const } : {}),
    chatResponse: responseText,
    responseHtml: renderChatMarkdownToHtml(responseText),
    contextFiles: [...contextFiles].slice(0, 20),
    applyPatches: [],
    fileDiffs: [],
    toolCallLog: loop.toolCallLog,
  };
}
