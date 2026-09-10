import { useEffect, useRef, type Dispatch, type RefObject } from "react";
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

function flushBuffer(): void {
  // No-op: the uiScheduler flushes coalesce buffers before every batch/priority
  // emission, guaranteeing narration_batch arrives before the tool_call that follows.
}

// ---------------------------------------------------------------------------
// computeStreamingAnswerUpdate — pure; extracted so the reset/accumulate/cap
// logic is unit-testable without a hook-rendering harness, the same reason
// formatCompactionNarration above is separated from its own stateful handler.
// ---------------------------------------------------------------------------

/**
 * Reset key is `${runId}:${iter}`, not `iter` alone and not a run/turn boundary event: the
 * main call and its own auto-continuation deliberately share one `iter` within a run
 * (agentLoop.ts's onTextDelta closure comment explains why — a continuation extends the same
 * answer), so they correctly append; a genuinely new LLM turn within the same run carries a
 * new `iter` and correctly resets. `runId` in the key closes a gap `iter` alone cannot: two
 * runs can coincidentally end/start on the same iter number (e.g. both are one-iteration
 * runs), and `iter` alone would misread that as a continuation. `runId` is never reused
 * across runs, so folding it in resets correctly at every run boundary — including
 * RUN_ABORTED (Esc) and a fresh USER_PROMPT submission, neither of which is a bus event this
 * hook can listen for directly.
 */
export const STREAMING_ANSWER_TAIL_CAP = 2000;

export function computeStreamingAnswerUpdate(
  prev: { buffer: string; key: string | null },
  event: { runId?: string; iter?: number; delta?: string },
  tailCap: number = STREAMING_ANSWER_TAIL_CAP
): { buffer: string; key: string } {
  const fragment = event.delta ?? "";
  const key = `${event.runId ?? ""}:${event.iter ?? ""}`;
  const isNewTurn = key !== prev.key;
  let buffer = (isNewTurn ? "" : prev.buffer) + fragment;
  if (buffer.length > tailCap) buffer = buffer.slice(-tailCap);
  return { buffer, key };
}

// ---------------------------------------------------------------------------
// useAgentEvents hook
// ---------------------------------------------------------------------------

export function useAgentEvents(
  bus: EventBus | undefined,
  dispatch: Dispatch<StoreAction>,
  trustedPrefixesRef: RefObject<string[]> = { current: [] },
  modeRef: RefObject<TuiMode> = { current: "normal" }
): void {
  // Phase 4a — streaming answer state still lives here (the scheduler only
  // coalesces deltas into streaming_batch; the reset/accumulate/cap logic for
  // the store field stays in the consumer).
  const streamingAnswerBuffer = useRef("");
  const streamingAnswerLastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!bus) return;

    // Phase 4a — narration_batch arrives from the scheduler with aggregated text.
    // Same dispatch the old debounced flush produced.
    function handleNarrationBatch(evt: ZoneStructuredProgressEvent): void {
      const text = (evt as any).text as string | undefined;
      if (!text) return;
      dispatch({ type: "TRANSCRIPT_APPEND_NARRATION", text });
    }

    // Phase 4a — streaming_batch arrives from the scheduler with aggregated delta text.
    // Uses the same computeStreamingAnswerUpdate for reset/accumulate/cap semantics.
    function handleStreamingBatch(evt: ZoneStructuredProgressEvent): void {
      const text = (evt as any).text as string | undefined;
      if (!text) return;
      const { buffer, key } = computeStreamingAnswerUpdate(
        { buffer: streamingAnswerBuffer.current, key: streamingAnswerLastKey.current },
        { runId: evt.runId, iter: evt.iter, delta: text },
      );
      streamingAnswerBuffer.current = buffer;
      streamingAnswerLastKey.current = key;
      dispatch({ type: "STREAMING_ANSWER_SET", text: streamingAnswerBuffer.current });
    }

    const ctx = (): EventCtx => ({
      trustedPrefixes: trustedPrefixesRef.current ?? [],
      mode: modeRef.current ?? "normal",
    });

    const applyActions = (actions: StoreAction[]) => { for (const a of actions) dispatch(a); };

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
      applyActions(actions);
    };

    // Flush-first: Phase 4a — flushBuffer is now a no-op (scheduler owns ordering).
    // The handler still runs eventToActions + intents/actions in the same order.
    const flushFirst = (evt: ZoneStructuredProgressEvent) => {
      flushBuffer();
      const { actions, intents } = eventToActions(evt, ctx());
      applyIntents(intents);
      applyActions(actions);
    };

    // command_approval_required: conditional flush
    // Trusted path → intents=[resolveCommand], actions=[] → no flush (silent auto-approve)
    // Non-trusted → actions=[PENDING_APPROVAL_SET], intents=[] → flush then show modal
    const handleCommandApproval = (evt: ZoneStructuredProgressEvent) => {
      const { actions, intents } = eventToActions(evt, ctx());
      applyIntents(intents);
      if (actions.length > 0) {
        flushBuffer();
        applyActions(actions);
      }
    };

    bus.on("run_failed",               flushFirst);
    bus.on("plan_ready_for_approval",  simple);
    bus.on("agent_loop_start",         simple);
    bus.on("agent_loop_complete",      flushFirst);
    bus.on("run_summary",              flushFirst);
    // Phase 4a — scheduler emits narration_batch on "narration" channel and
    // streaming_batch on "chat_chunk" channel. The original event types are
    // coalesced by the scheduler and never reach these handlers directly.
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
    };
  }, [bus, dispatch]);
}
