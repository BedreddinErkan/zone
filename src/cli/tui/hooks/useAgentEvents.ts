import { useEffect, type Dispatch, type RefObject } from "react";
import type { EventBus } from "../../eventBus.js";
import type { StoreAction, TuiMode } from "../store.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import { resolveCommandApproval } from "../../../api/commandApprovals.js";
import { resolveRevisionApproval } from "../../../llm/revisionApprovals.js";
import { formatCompactionNarration } from "../../../core/compactionNarration.js";
// re-exported so existing callers importing it from this module continue to work
export { formatCompactionNarration };
import {
  eventToActions,
  type EventCtx,
  type ResolverIntent,
  SPINNER_LABEL_STARTING,
  SPINNER_LABEL_PLANNING,
} from "./eventToActions.js";
export { SPINNER_LABEL_STARTING, SPINNER_LABEL_PLANNING };

// ---------------------------------------------------------------------------
// Exported handler functions (tested directly; thin wrappers over eventToActions)
// ---------------------------------------------------------------------------

export function handleCompactionStarted(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handleCompactionStatus(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handleCompactionExhausted(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handleCompactionOverflow(
  _evt: unknown,
  dispatch: Dispatch<StoreAction>
): void {
  // _evt content is irrelevant — synthesize the type so eventToActions hits the right case
  const typed = { type: "compaction_overflow_warning" } as ZoneStructuredProgressEvent;
  const { actions } = eventToActions(typed, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handleTodosInitialized(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handleTodoRevised(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handleTodoStatusChanged(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handleEditApproval(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handlePlanGenerationStarted(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handlePlanReadyForApprovalExported(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

export function handleStagedDiffsReadyExported(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const { actions } = eventToActions(evt, { trustedPrefixes: [], mode: "normal" });
  for (const action of actions) dispatch(action);
}

// ---------------------------------------------------------------------------
// flushBuffer — Phase 4a: scheduler now owns narration coalescing and ordering.
// flushFirst handlers still call this, but it is now a no-op since there is
// no local buffer to drain. Kept as a function so call sites stay unchanged
// and the scheduler's ordering guarantee is the single source of truth.
// ---------------------------------------------------------------------------

// Compatibility exports; accumulation now belongs to the pure reducer.
export { computeStreamingAnswerUpdate, STREAMING_ANSWER_TAIL_CAP } from "../store-core.js";

export function useAgentEvents(
  bus: EventBus | undefined,
  dispatch: Dispatch<StoreAction>,
  trustedPrefixesRef: RefObject<string[]> = { current: [] },
  modeRef: RefObject<TuiMode> = { current: "normal" }
): void {
  useEffect(() => {
    if (!bus) return;

    function applyProgress(evt: ZoneStructuredProgressEvent, actions: StoreAction[]): void {
      dispatch({ type: "PROGRESS_RECEIVED", event: evt, actions });
    }

    function handleNarrationBatch(evt: ZoneStructuredProgressEvent): void {
      const text = evt.text ?? evt.delta ?? evt.title;
      if (text) applyProgress(evt, [{ type: "TRANSCRIPT_APPEND_NARRATION", text }]);
    }

    function handleStreamingBatch(evt: ZoneStructuredProgressEvent): void {
      if (evt.delta) applyProgress(evt, [{ type: "STREAMING_ANSWER_DELTA", delta: evt.delta, iter: evt.iter }]);
    }

    const ctx = (): EventCtx => ({
      trustedPrefixes: trustedPrefixesRef.current ?? [],
      mode: modeRef.current ?? "normal",
    });

    const applyIntents = (intents: ResolverIntent[]) => {
      for (const intent of intents) {
        if (intent.kind === "resolveCommand") {
          resolveCommandApproval({ approvalId: intent.approvalId, runId: intent.runId, approved: intent.approved });
        } else if (intent.kind === "resolveRevision") {
          resolveRevisionApproval({ revisionId: intent.revisionId, runId: intent.runId, decision: intent.decision });
        }
      }
    };

    // Simple: intents then actions, no flush
    const simple = (evt: ZoneStructuredProgressEvent) => {
      const { actions, intents } = eventToActions(evt, ctx());
      applyIntents(intents);
      applyProgress(evt, actions);
    };

    // Ordering is established by the scheduler before either handler is invoked.
    const flushFirst = simple;

    // command_approval_required: conditional flush
    // Trusted path → intents=[resolveCommand], actions=[] → no flush (silent auto-approve)
    // Non-trusted → actions=[PENDING_APPROVAL_SET], intents=[] → flush then show modal
    const handleCommandApproval = (evt: ZoneStructuredProgressEvent) => {
      const { actions, intents } = eventToActions(evt, ctx());
      applyIntents(intents);
      if (actions.length > 0) {
        applyProgress(evt, actions);
      }
    };

    bus.on("run_failed",               flushFirst);
    bus.on("plan_ready_for_approval",  simple);
    bus.on("agent_loop_start",         simple);
    bus.on("agent_loop_complete",      flushFirst);
    bus.on("run_summary",              flushFirst);
    // Scheduler preserves typed incremental events and their ownership metadata.
    bus.on("narration",                handleNarrationBatch);
    bus.on("thinking",                 simple);
    bus.on("chat_chunk",               handleStreamingBatch);
    bus.on("chat_response",            handleNarrationBatch);
    bus.on("tool_call",                flushFirst);
    bus.on("tool_result",              simple);
    bus.on("terminal_output",          simple);
    bus.on("terminal_done",            simple);
    bus.on("ranking_context",          simple);
    bus.on("generating_patch",         simple);
    bus.on("verification",             simple);
    bus.on("verification_investigating", simple);
    bus.on("verification_fixing",      simple);
    bus.on("verification_fixed",       simple);
    bus.on("llm_retry_in_progress",    simple);
    bus.on("iter_cost_update",         simple);
    bus.on("token_budget_status",      simple);
    bus.on("patch_rejected",           simple);
    bus.on("loop_warning_emitted",     simple);
    bus.on("loop_detected_terminal",   simple);
    bus.on("command_approval_required", handleCommandApproval);
    bus.on("edit_approval_required",   flushFirst);
    bus.on("trust_approval_required",  flushFirst);
    // flushFirst: pending narration must land in the transcript BEFORE the
    // question pins, or the reasoning that led to it appears after the ask.
    bus.on("user_question_required",   flushFirst);
    bus.on("scope_revision_proposed",  simple);

    bus.on("compaction_started",          simple);
    bus.on("compaction_status",           simple);
    bus.on("compaction_exhausted",        simple);
    bus.on("compaction_overflow_warning", simple);

    bus.on("todos_initialized",   simple);
    bus.on("todo_revised",        simple);
    bus.on("todo_status_changed", simple);

    bus.on("plan_generation_started",         simple);
    bus.on("staged_diffs_ready_for_approval", simple);
    bus.on("post_execute_diffs",              simple);
    bus.on("hook_completed",                  simple);
    bus.on("mcp_connected",                   simple);
    bus.on("mcp_tool_called",                 simple);

    // Phase 5a — subagent lifecycle. Simple dispatch (no flush needed — these are
    // bookkeeping events, not user-facing content that must follow narration).
    bus.on("subagent_started",                simple);
    bus.on("subagent_completed",              simple);

    return () => {
      bus.off("run_failed",               flushFirst);
      bus.off("plan_ready_for_approval",  simple);
      bus.off("agent_loop_start",         simple);
      bus.off("agent_loop_complete",      flushFirst);
      bus.off("run_summary",              flushFirst);
      bus.off("narration",                handleNarrationBatch);
      bus.off("thinking",                 simple);
      bus.off("chat_chunk",               handleStreamingBatch);
      bus.off("chat_response",            handleNarrationBatch);
      bus.off("tool_call",                flushFirst);
      bus.off("tool_result",              simple);
      bus.off("terminal_output",          simple);
      bus.off("terminal_done",            simple);
      bus.off("ranking_context",          simple);
      bus.off("generating_patch",         simple);
      bus.off("verification",             simple);
      bus.off("verification_investigating", simple);
      bus.off("verification_fixing",      simple);
      bus.off("verification_fixed",       simple);
      bus.off("llm_retry_in_progress",    simple);
      bus.off("iter_cost_update",         simple);
      bus.off("token_budget_status",      simple);
      bus.off("patch_rejected",           simple);
      bus.off("loop_warning_emitted",     simple);
      bus.off("loop_detected_terminal",   simple);
      bus.off("command_approval_required", handleCommandApproval);
      bus.off("edit_approval_required",   flushFirst);
      bus.off("trust_approval_required",  flushFirst);
      bus.off("user_question_required",   flushFirst);
      bus.off("scope_revision_proposed",  simple);

      bus.off("compaction_started",          simple);
      bus.off("compaction_status",           simple);
      bus.off("compaction_exhausted",        simple);
      bus.off("compaction_overflow_warning", simple);

      bus.off("todos_initialized",   simple);
      bus.off("todo_revised",        simple);
      bus.off("todo_status_changed", simple);

      bus.off("plan_generation_started",         simple);
      bus.off("staged_diffs_ready_for_approval", simple);
      bus.off("post_execute_diffs",              simple);
      bus.off("hook_completed",                  simple);
      bus.off("mcp_connected",                   simple);
      bus.off("mcp_tool_called",                 simple);
      bus.off("subagent_started",                simple);
      bus.off("subagent_completed",              simple);
    };
  }, [bus, dispatch]);
}
