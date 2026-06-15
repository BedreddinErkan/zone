import { useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject } from "react";
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
// flushBuffer — stateful utility; stays here because it owns the refs
// ---------------------------------------------------------------------------

function flushBuffer(
  localBuffer: MutableRefObject<string>,
  debounceTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  dispatch: Dispatch<StoreAction>
): void {
  if (debounceTimer.current !== null) {
    clearTimeout(debounceTimer.current);
    debounceTimer.current = null;
  }
  if (localBuffer.current) {
    dispatch({ type: "TRANSCRIPT_APPEND_NARRATION", text: localBuffer.current });
    localBuffer.current = "";
  }
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
  const localBuffer = useRef("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!bus) return;

    // Narration text: debounced — NOT handled by eventToActions
    function handleTextEvent(evt: ZoneStructuredProgressEvent): void {
      const text = evt.text ?? evt.delta ?? evt.title ?? "";
      if (!text) return;
      localBuffer.current += text;
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        dispatch({ type: "TRANSCRIPT_APPEND_NARRATION", text: localBuffer.current });
        localBuffer.current = "";
        debounceTimer.current = null;
      }, 200);
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

    // Flush-first: flushBuffer before intents/actions
    const flushFirst = (evt: ZoneStructuredProgressEvent) => {
      flushBuffer(localBuffer, debounceTimer, dispatch);
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
        flushBuffer(localBuffer, debounceTimer, dispatch);
        applyActions(actions);
      }
    };

    bus.on("run_failed",               flushFirst);
    bus.on("plan_ready_for_approval",  simple);
    bus.on("agent_loop_start",         simple);
    bus.on("agent_loop_complete",      flushFirst);
    bus.on("run_summary",              flushFirst);
    bus.on("narration",                handleTextEvent);
    bus.on("thinking",                 simple);
    bus.on("chat_chunk",               handleTextEvent);
    bus.on("chat_response",            handleTextEvent);
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
    bus.on("scope_audit_started",      simple);
    bus.on("iter_cost_update",         simple);
    bus.on("token_budget_status",      simple);
    bus.on("patch_rejected",           simple);
    bus.on("phase_changed",            flushFirst);
    bus.on("loop_warning_emitted",     simple);
    bus.on("loop_detected_terminal",   simple);
    bus.on("command_approval_required", handleCommandApproval);
    bus.on("edit_approval_required",   flushFirst);
    bus.on("trust_approval_required",  flushFirst);
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
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      bus.off("run_failed",               flushFirst);
      bus.off("plan_ready_for_approval",  simple);
      bus.off("agent_loop_start",         simple);
      bus.off("agent_loop_complete",      flushFirst);
      bus.off("run_summary",              flushFirst);
      bus.off("narration",                handleTextEvent);
      bus.off("thinking",                 simple);
      bus.off("chat_chunk",               handleTextEvent);
      bus.off("chat_response",            handleTextEvent);
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
      bus.off("scope_audit_started",      simple);
      bus.off("iter_cost_update",         simple);
      bus.off("token_budget_status",      simple);
      bus.off("patch_rejected",           simple);
      bus.off("phase_changed",            flushFirst);
      bus.off("loop_warning_emitted",     simple);
      bus.off("loop_detected_terminal",   simple);
      bus.off("command_approval_required", handleCommandApproval);
      bus.off("edit_approval_required",   flushFirst);
      bus.off("trust_approval_required",  flushFirst);
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
