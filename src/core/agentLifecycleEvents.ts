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
] as const;

export type AgentLifecycleEventType = (typeof AGENT_LIFECYCLE_EVENT_TYPES)[number];

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

/** Rich UI progress payload (SSE); legacy `stage` string remains for older clients. */
export type ZoneStructuredProgressEvent = {
  runId: string;
  ts: number;
  type:
    | "reading_file"
    | "ranking_context"
    | "context_ready"
    | "generating_patch"
    | "patch_rejected"
    | "fallback"
    | "fallback_success"
    | "patch_converted"
    | "validated"
    | "verification";
  title: string;
  detail?: string;
  filePath?: string;
  command?: string;
  status?: "active" | "success" | "warning" | "error";
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
