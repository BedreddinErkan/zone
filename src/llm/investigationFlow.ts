import { renderChatMarkdownToHtml } from "./renderChatMarkdown.js";
import { runAgentLoop, TOKEN_BUDGET_CAP } from "./agentLoop.js";
import { EXPLORE_ALLOWED_TOOLS, AUDIT_ALLOWED_TOOLS, computeExploreMaxIterations } from "./subagents.js";
import { CHAT_TOOLS } from "../tools/toolDefinitions.js";
import type { Capability } from "../tools/capabilities.js";
import type { ToolResult } from "../tools/toolExecutor.js";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";
import type { TaskTier } from "./taskClassifier.js";
import type { LLMProvider } from "./types.js";
import { debugLog, log } from "../utils/logger.js";

export interface InvestigateScopeOpts {
  repoPath: string;
  query: string;
  runId?: string;
  /** Remaining tokens in the parent run. Audit refused if < 50k; capped at 200k. */
  tokenBudgetRemaining?: number;
  abortSignal?: AbortSignal;
  userApiKey?: string;
  /** Provider to use for the investigation (inherits from the parent run). */
  provider?: LLMProvider;
  /**
   * Parent run's classified tier. Threaded into the audit agentLoop so
   * tier-constraints-applied logs the correct tier instead of defaulting to medium.
   */
  parentTier?: TaskTier;
  /**
   * Phase D-S1: hard iteration cap for Phase 1 of a phase-split run.
   * When set, overrides computeExploreMaxIterations(1)=15 so Phase 1 stays
   * within its allocated budget and leaves capacity for Phase 2.
   */
  maxIterationsOverride?: number;
  onProgress?: (update: {
    stage: string;
    progress?: Partial<ZoneStructuredProgressEvent>;
  }) => void;
}

export interface InvestigateScopeResult {
  findings: string;
  citations: Array<{ file: string; line?: number }>;
  toolCallCount: number;
  tokensUsed: number;
  costUsd: number;
  skipped?: boolean;
  skipReason?: string;
  /** Set when the investigation agent explicitly called suggest_scope_change. */
  agentSuggestedRevision?: {
    type: "under_scope" | "over_scope" | "mixed";
    reason: string;
    missingFiles?: string[];
    unnecessaryFiles?: string[];
    revisedPlanSummary: string;
  };
  /** Deduped list of files read during investigation — for auditFindings handoff to Phase 2. */
  filesAlreadyRead?: string[];
  // Step C: structured Phase 1 output extracted from the INVESTIGATION_OUTPUT_FORMAT JSON block.
  rootCause?: string;
  fixInstruction?: string;
  filesToEdit?: string[];
  evidence?: string;
}

function extractCitations(text: string): Array<{ file: string; line?: number }> {
  const seen = new Map<string, { file: string; line?: number }>();
  for (const m of text.matchAll(/`([^`]+\.[a-zA-Z]+(?::(\d+))?)`/g)) {
    const raw = m[1] ?? "";
    const colonIdx = raw.lastIndexOf(":");
    const hasLine = colonIdx > 0 && /^\d+$/.test(raw.slice(colonIdx + 1));
    const file = hasLine ? raw.slice(0, colonIdx) : raw;
    const line = hasLine ? parseInt(raw.slice(colonIdx + 1), 10) : undefined;
    if (!seen.has(file)) seen.set(file, { file, ...(line !== undefined ? { line } : {}) });
  }
  return Array.from(seen.values());
}

const AUDIT_TOKEN_CAP = 200_000;
const MIN_TOKENS_TO_START = 50_000;

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

/**
 * Pure investigation runner for in-process callers (Phase AS scope audit).
 * Callable from server.ts between plan approval and execute — does not require
 * an HTTP round-trip to /api/investigate.
 */
export async function investigateScope(opts: InvestigateScopeOpts): Promise<InvestigateScopeResult> {
  const tokenBudgetRemaining = opts.tokenBudgetRemaining ?? Infinity;

  if (isFinite(tokenBudgetRemaining) && tokenBudgetRemaining < MIN_TOKENS_TO_START) {
    log("[zone-investigation-summary]", JSON.stringify({
      event: "investigation_summary",
      runId: opts.runId || null,
      toolCallCount: 0,
      totalCostUsd: 0,
      citationCount: 0,
      query: String(opts.query || "").slice(0, 100),
      finalState: "skipped",
      skipReason: "insufficient_token_budget",
      ts: new Date().toISOString(),
    }));
    return { findings: "", citations: [], toolCallCount: 0, tokensUsed: 0, costUsd: 0, skipped: true, skipReason: "insufficient_token_budget" };
  }

  const runId = opts.runId ?? "";
  const contextFiles = new Set<string>();
  let agentSuggestedRevision: InvestigateScopeResult["agentSuggestedRevision"];

  const emitStructuredProgress = (progress: Partial<ZoneStructuredProgressEvent>): void => {
    if (!runId) return;
    opts.onProgress?.({
      stage: "scope_audit",
      progress: { runId, ts: Date.now(), ...progress } as Partial<ZoneStructuredProgressEvent>,
    });
  };

  if (runId) {
    emitStructuredProgress({ type: "agent_loop_start", title: "Starting scope investigation", status: "active", lane: "audit" });
  }

  // AS.1: enforce auditCap via tokenBudgetBaseTokens once tier-cap /
  // TOKEN_BUDGET_CAP alignment is resolved. For AS.0 the iteration cap
  // (EXPLORE_ITER_FLOOR = 15) naturally bounds audit token spend.
  const _auditCap = isFinite(tokenBudgetRemaining)
    ? Math.min(tokenBudgetRemaining, AUDIT_TOKEN_CAP)
    : AUDIT_TOKEN_CAP;
  void _auditCap;

  const planStepsCount = 1;
  const computedMax = opts.maxIterationsOverride ?? computeExploreMaxIterations(planStepsCount);

  const parentTaskClassification = opts.parentTier
    ? {
        tier: opts.parentTier,
        confidence: 1.0,
        fallbackUsed: false,
        estimatedFiles: 0,
        estimatedIterations: 0,
        classifierCostUsd: 0,
        classifierLatencyMs: 0,
        classifierModel: "parent",
        archetype: "investigation" as const,
        archetypeConfidence: 1.0,
      }
    : undefined;

  const loop = await runAgentLoop({
    task: opts.query,
    repoPath: opts.repoPath,
    runId: runId || undefined,
    userApiKey: opts.userApiKey,
    provider: opts.provider,
    abortSignal: opts.abortSignal,
    mode: "investigation",
    capabilityFilter: { allowToolNames: new Set([...AUDIT_ALLOWED_TOOLS]) },
    maxIterationsOverride: computedMax,
    lane: "audit",
    ...(parentTaskClassification ? { taskClassification: parentTaskClassification } : {}),
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
      if (e["type"] === "suggest_scope_change") {
        agentSuggestedRevision = {
          type: e["scopeChangeType"] as "under_scope" | "over_scope" | "mixed",
          reason: String(e["reason"] || ""),
          ...(Array.isArray(e["missingFiles"]) ? { missingFiles: e["missingFiles"] as string[] } : {}),
          ...(Array.isArray(e["unnecessaryFiles"]) ? { unnecessaryFiles: e["unnecessaryFiles"] as string[] } : {}),
          revisedPlanSummary: String(e["revisedPlanSummary"] || ""),
        };
      }
      if (e["type"] === "narration") {
        emitStructuredProgress({
          type: "narration",
          title: String(e["title"] || "").slice(0, 200),
          text: String(e["text"] || "").slice(0, 2000),
          iter: typeof e["iter"] === "number" ? e["iter"] : undefined,
          status: "active",
        } as Partial<ZoneStructuredProgressEvent>);
      }
      if (e["type"] === "iter_cost_update") {
        emitStructuredProgress({
          type: "iter_cost_update",
          title: String(e["title"] || "Iteration cost"),
          status: "active",
          ...e,
        } as Partial<ZoneStructuredProgressEvent>);
      }
      if (e["type"] === "token_budget_status") {
        emitStructuredProgress({
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

  const findings = String(loop.summary || "").trim() || "No findings.";
  const citations = extractCitations(findings);
  const tokensUsed = loop.tokenUsage?.total ?? 0;
  const costUsd = loop.costUsd ?? 0;
  const citationCount = citations.length;

  emitStructuredProgress({
    type: "agent_loop_complete",
    title: loop.success ? "Scope investigation complete" : "Scope investigation ended",
    detail: findings.slice(0, 4000),
    status: loop.success ? "success" : "warning",
    lane: "audit",
  });

  log("[zone-investigation-summary]", JSON.stringify({
    event: "investigation_summary",
    runId: runId || null,
    toolCallCount: loop.toolCallLog.length,
    totalCostUsd: costUsd,
    citationCount,
    query: String(opts.query || "").slice(0, 100),
    finalState: loop.terminationReason ?? "success",
    ts: new Date().toISOString(),
  }));

  const filesAlreadyRead = [
    ...new Set(
      loop.toolCallLog
        .filter((tc) => tc.tool === "read_file" && typeof tc.args["filePath"] === "string")
        .map((tc) => tc.args["filePath"] as string)
    ),
  ];

  const phase1Structured = extractPhase1Findings(findings);

  return {
    findings,
    citations,
    toolCallCount: loop.toolCallLog.length,
    tokensUsed,
    costUsd,
    ...(agentSuggestedRevision ? { agentSuggestedRevision } : {}),
    ...(filesAlreadyRead.length ? { filesAlreadyRead } : {}),
    ...phase1Structured,
  };
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

export type ChatAgentFlowResult = {
  ok: true;
  decisionMode: "chat";
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
  const hitMaxIter =
    terminationReason === "max_iterations" ||
    (!loop.success && !hitTokenBudget && !hitCompactionExhausted);
  const responseText = String(loop.summary || "").trim() || "I could not produce an investigation answer.";
  emitStructuredProgress({
    type: "agent_loop_complete",
    title: loop.success
      ? "Investigation complete"
      : hitCompactionExhausted
        ? "Investigation aborted — context exhausted"
        : hitTokenBudget
          ? "Investigation ended at token budget"
          : "Investigation ended with partial findings",
    detail: responseText.slice(0, 4000),
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
    capabilityFilter: { allowToolNames: new Set(CHAT_TOOLS) },
    maxIterationsOverride: 6,
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
