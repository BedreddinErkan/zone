import type { VerificationReason } from "../llm/agentLoop.js";
import type { VerificationCommand } from "./verdictClassifier.js";

export const AGENT_LIFECYCLE_EVENT_TYPES = [
  "run_started",
  "intent_understood",
  "repo_explored",
  "relevant_files_ranked",
  "plan_created",
  "patch_preview_empty_fallback_target_selected",
  "file_context_loaded",
  "patch_generation_started",
  "patch_generated",
  "patch_generation_failed",
  "patch_correctness_checked",
  "verification_planned",
  "verification_started",
  "verification_passed",
  "verification_failed",
  "tooling_issue",
  "run_completed",
  "run_cancelled",
] as const;

export type AgentLifecycleEventType = (typeof AGENT_LIFECYCLE_EVENT_TYPES)[number];

export const SUBAGENT_STRUCTURED_PROGRESS_EVENT_TYPES = [
  "subagent_started",
  "subagent_completed",
] as const;

/** Coarse pipeline stage for UI grouping (distinct from legacy progress strings). */
export type AgentLifecyclePipelineStage =
  | "init"
  | "intent"
  | "repo"
  | "rank"
  | "plan"
  | "scope_revision"
  | "context"
  | "patch_preview"
  | "patch_gen"
  | "correctness"
  | "verification"
  | "finalize";

export type AgentLifecycleEvent = {
  type: AgentLifecycleEventType;
  message: string;
  stage: AgentLifecyclePipelineStage;
  filePath?: string;
  command?: string;
  status?: string;
  timestamp: string;
};

/** Payload for `handoff_report` progress events and persisted run results. */
export type ZoneHandoffReport = {
  summary: string;
  changes: Array<{
    file: string;
    added: number;
    removed: number;
    description: string;
  }>;
  verification: "passed" | "skipped" | "failed";
  suggestedNextPrompt: string;
};

export type RunSummaryPayload = {
  filesChanged: Array<{
    filePath: string;
    addedLines: number;
    removedLines: number;
  }>;
  toolsUsed: Record<string, number>;
  verification: {
    reason: VerificationReason;
    note: string;
    commands: VerificationCommand[];
    // Phase J.3: "rolled_back" added when post-apply verification regressed;
    // the run summary still surfaces the verification reason and command log.
    // Phase J.4: dropped "preview_only" — J.1 collapsed it into safe_to_apply
    // and the derived value never lands on preview_only anymore.
    decisionMode: "safe_to_apply" | "rolled_back";
  };
  cost: {
    totalUsd: number;
    iterCount: number;
    cacheHitPct: number;
    avgIterUsd: number;
  };
};

/** Rich UI progress payload (SSE); legacy `stage` string remains for older clients. */
export type ZoneStructuredProgressEvent = {
  runId: string;
  ts: number;
  type:
    | "reading_file"
    | "ranking_context"
    | "context_ready"
    | "generating_patch"
    | "planner_result"
    | "patch_rejected"
    | "fallback"
    | "fallback_success"
    | "patch_converted"
    | "validated"
    | "verification"
    | "verification_investigating"
    | "verification_fixing"
    | "verification_fixed"
    | "chat_start"
    | "chat_chunk"
    | "chat_done"
    | "chat_response"
    | "todos_initialized"
    | "todo_status_changed"
    | "todo_revised"
    | "patch_stream_delta"
    | "patch_stream_target"
    | "tool_call"
    | "tool_result"
    | "agent_loop_start"
    | "agent_loop_complete"
    | "run_summary"
    | "iter_cost_update"
    | "subagent_started"
    | "subagent_completed"
    | "handoff_report"
    | "command_approval_required"
    | "command_auto_approved"
    | "command_trusted"
    | "terminal_output"
    | "terminal_done"
    | "narration"
    | "token_budget_status"
    | "task_classified"
    | "tier_constraints_applied"
    | "loop_warning_emitted"
    | "loop_detected_terminal"
    | "tool_input_delta"
    /** Y.1.6.3: emitted once per retry sequence when cumulative wait exceeds 5 s. */
    | "llm_retry_in_progress"
    /** Phase AS: scope revision proposal emitted between plan approval and execute. */
    | "scope_revision_proposed"
    | "scope_revision_resolved"
    | "scope_audit_started"
    | "scope_audit_completed"
    | "scope_audit_skipped"
    /** Phase Z: plan generation summary emitted inline (replaces plan card). */
    | "plan_summary"
    /** Phase D-S1: emitted exactly once when Phase 1 (investigation) hands off to Phase 2 (execution). */
    | "phase_changed"
    /** Compact.1: compaction lifecycle events. compaction_started is typed but not yet emitted
     *  (wired in Compact.3 together with the TUI spinner consumer). */
    | "compaction_started"
    | "compaction_status"
    | "compaction_exhausted"
    | "compaction_overflow_warning"
    /** Scope-block circuit breaker: emitted when consecutive scope-blocked writes reach the terminate threshold. */
    | "scope_block_circuit_terminal";
  title: string;
  detail?: string;
  filePath?: string;
  command?: string;
  status?: "active" | "success" | "warning" | "error";
  /** scope_block_circuit_terminal: number of consecutive scope-blocked writes that triggered the breaker. */
  blockedCount?: number;
  subagentStatus?: "completed" | "partial" | "failed" | "max_iterations";
  subagentId?: string;
  subagentType?: "worker" | "explore" | "verifier";
  parentRunId?: string;
  stream?: "stdout" | "stderr";
  exitCode?: number;
  iter?: number;
  totalIter?: number;
  iterCost?: number;
  cumulativeCost?: number;
  cacheHitThisIter?: number;
  cacheHitCumulative?: number;
  input_uncached?: number;
  cache_write?: number;
  cache_read?: number;
  output?: number;
  total_input_uncached?: number;
  total_cache_read?: number;
  total_cache_write?: number;
  total_output?: number;
  iter_count?: number;
  approvalId?: string;
  todos?: Array<{
    id: string;
    text: string;
    description?: string;
    filesLikely?: string[];
    status: "pending" | "in_progress" | "completed" | "skipped";
  }>;
  todoId?: string;
  todoStatus?: "pending" | "in_progress" | "completed" | "skipped";
  delta?: string;
  /** True when backend emitted a single fallback delta (not real token streaming). */
  fallback?: boolean;
  targetSymbol?: string;
  report?: ZoneHandoffReport;
  filesChanged?: RunSummaryPayload["filesChanged"];
  toolsUsed?: RunSummaryPayload["toolsUsed"];
  verification?: RunSummaryPayload["verification"];
  cost?: RunSummaryPayload["cost"];
  responseText?: string;
  responseHtml?: string;
  contextFiles?: string[];
  /** Plain-text narration emitted by the agent loop between tool calls. */
  text?: string;
  planner?: {
    changeDescription: string;
    strategy: string;
    filesToEdit: string[];
    relatedFiles?: Array<{ filePath: string; relationship: string; score: number }>;
    /** Cross-file dependency hints (e.g. imports / dependents). */
    warnings?: string[];
  };
  /** Phase H.7 token-budget tracking — cumulative input+output across the run,
   *  cap (default 800k), and ratio. Emitted once per iter. UI uses ratio for
   *  cost-strip warn/alert states and the run terminates when ratio ≥ HARD. */
  cumulativeTokens?: number;
  tokenBudgetCap?: number;
  tokenBudgetRatio?: number;
  breakdown?: {
    mainAgent?: number;
    subagents?: number;
  };
  /** Phase I.5: tool name + structured metadata for tool_result events whose
   *  UI render depends on more than the output text (verify_visual surfaces
   *  the screenshot via metadata.screenshotPath / pageTitle / consoleErrors). */
  toolName?: string;
  /** TUI.10.I: patch content for apply_patch tool calls; used for inline diff display. */
  patch?: string;
  metadata?: Record<string, unknown>;
  /** Phase F1: live tool-input streaming. Identifies the specific LLM tool call
   *  block (unique per call, per iteration) and whether this event is the first
   *  delta seen for that block. */
  blockId?: string;
  isFirstDelta?: boolean;
  /** Phase AS: scope revision proposal fields on scope_revision_proposed events. */
  revisionId?: string;
  revisionType?: "under_scope" | "over_scope" | "mixed";
  revisionReason?: string;
  revisionOriginalPlan?: string;
  revisionRevisedPlanSummary?: string;
  revisionMissingFiles?: string[];
  revisionUnnecessaryFiles?: string[];
  /** scope_revision_resolved: user decision */
  revisionDecision?: "approve" | "reject";
  /** scope_audit_skipped reason */
  skipReason?: string;
  /** Phase O: identifies which agent lane emitted this event. "audit" = scope
   *  audit mini-agent running investigateScope(); "main" = primary patch/investigate
   *  agent. Absent for events that predate lane tagging. */
  lane?: "main" | "audit";
  /** Phase Z: plan_summary fields — deduplicated file list and step count. */
  planSummaryFiles?: string[];
  planSummaryStepCount?: number;
  /** Phase D-S1: phase_changed event fields. phase=2 means Phase 1 is done, Phase 2 starting. */
  phase?: number;
  remainingTokenBudget?: number;
  /** Compact.1+2: compaction event fields.
   *  count: compaction sequence number (1–5).
   *  message: user-visible reason on compaction_exhausted.
   *  tokensBefore/tokensAfter/savedTokens: chars/4 context-window estimates on compaction_status. */
  count?: number;
  message?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  savedTokens?: number;
  /** Phase L.1: pre-dispatch task classification. Emitted once per dispatch
   *  before the agent loop starts so the UI / telemetry can show the predicted
   *  tier and the classifier's own cost. L.2 will gate tool exposure based on
   *  this, but in L.1 it is informational only. */
  tier?: "simple" | "medium" | "complex";
  estimatedFiles?: number;
  estimatedIterations?: number;
  confidence?: number;
  classifierModel?: string;
  classifierCostUsd?: number;
  classifierLatencyMs?: number;
  fallbackUsed?: boolean;
};

/** Documentation type for `narration` progress events: a one-line intent
 * statement the agent emits before invoking each tool. */
export type NarrationPayload = {
  text: string;
  iter?: number;
};

export function createAgentLifecycleEvent(
  input: Omit<AgentLifecycleEvent, "timestamp"> & { timestamp?: string }
): AgentLifecycleEvent {
  return {
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

export type LlmPatchProgressUpdate =
  | string
  | {
      stage: string;
      lifecycle?: AgentLifecycleEvent;
      progress?: ZoneStructuredProgressEvent;
    };
