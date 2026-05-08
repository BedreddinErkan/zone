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
    | "iter_cost_update"
    | "subagent_started"
    | "subagent_completed"
    | "handoff_report"
    | "command_approval_required"
    | "command_auto_approved"
    | "command_trusted"
    | "terminal_output"
    | "terminal_done";
  title: string;
  detail?: string;
  filePath?: string;
  command?: string;
  status?: "active" | "success" | "warning" | "error";
  subagentStatus?: "completed" | "partial" | "failed";
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
  responseText?: string;
  responseHtml?: string;
  contextFiles?: string[];
  planner?: {
    changeDescription: string;
    strategy: string;
    filesToEdit: string[];
    relatedFiles?: Array<{ filePath: string; relationship: string; score: number }>;
    /** Cross-file dependency hints (e.g. imports / dependents). */
    warnings?: string[];
  };
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
