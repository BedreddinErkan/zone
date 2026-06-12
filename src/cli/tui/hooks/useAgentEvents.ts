import { useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject } from "react";
import { randomUUID } from "node:crypto";
import type { EventBus } from "../../eventBus.js";
import type { StoreAction, TuiMode } from "../store.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import { resolveCommandApproval } from "../../../api/commandApprovals.js";
import { resolveTrustApproval } from "../../../api/trustApprovals.js";
import { resolveRevisionApproval } from "../../../llm/revisionApprovals.js";
import { buildLoopCompleteSummary, buildRunSummary } from "../../../core/eventProcessors.js";
// buildLoopCompleteSummary / buildRunSummary kept for future telemetry; run text no longer stored in transcript
import { formatCompactionNarration } from "../../../core/compactionNarration.js";
// re-exported so existing callers importing it from this module continue to work
export { formatCompactionNarration };
import type { RunTodo, TodoStatus } from "../../../core/todoLifecycle.js";
import type { StagedFile } from "../../../core/fileDiff.js";

export const SPINNER_LABEL_STARTING = "Starting…";
export const SPINNER_LABEL_PLANNING = "Planning…";

export function handleCompactionStarted(
  _evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  dispatch({ type: "SPINNER_UPDATE", label: "Compacting context…" });
}

export function handleCompactionStatus(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  dispatch({ type: "SPINNER_STOP" });
  const text = formatCompactionNarration({
    tokensBefore: evt.tokensBefore ?? 0,
    tokensAfter: evt.tokensAfter ?? 0,
    savedTokens: evt.savedTokens ?? 0,
    count: evt.count ?? 0,
  });
  dispatch({ type: "TRANSCRIPT_APPEND_NARRATION", text });
  dispatch({ type: "NARRATION_COMMIT" });
}

export function handleCompactionExhausted(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  dispatch({ type: "SPINNER_STOP" });
  dispatch({
    type: "TOAST_PUSH",
    entry: {
      id: randomUUID(),
      message: evt.message ?? "Context exhausted. Break this task into subtasks.",
      level: "warning",
    },
  });
}

export function handleCompactionOverflow(
  _evt: unknown,
  dispatch: Dispatch<StoreAction>
): void {
  dispatch({ type: "SPINNER_STOP" });
  dispatch({
    type: "TOAST_PUSH",
    entry: {
      id: randomUUID(),
      message: "Context window full — no history to compact",
      level: "warning",
    },
  });
}

export function handleTodosInitialized(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  dispatch({ type: "TODOS_SET", todos: (evt.todos as RunTodo[]) ?? [] });
}

export function handleTodoRevised(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  dispatch({ type: "TODOS_SET", todos: (evt.todos as RunTodo[]) ?? [] });
}

export function handleTodoStatusChanged(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  if (!evt.todoId) return;
  dispatch({
    type: "TODO_STATUS_SET",
    todoId: evt.todoId,
    status: evt.todoStatus as TodoStatus,
  });
}

export function handleEditApproval(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  const filePath = evt.filePath ?? (evt as any).command ?? "";
  const approvalId = evt.approvalId ?? "";
  if (!approvalId) return;
  dispatch({
    type: "PENDING_APPROVAL_SET",
    approvalId,
    runId: evt.runId ?? "",
    command: filePath,
    kind: "edit",
  });
}

export function handlePlanGenerationStarted(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  dispatch({ type: "SPINNER_START", label: evt.title ?? SPINNER_LABEL_PLANNING });
}

export function handlePlanReadyForApprovalExported(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  if (!evt.planId) return;
  let steps: Array<{ title: string; description: string; filesLikely: string[] }> = [];
  try {
    if (evt.planStepsJson) steps = JSON.parse(evt.planStepsJson);
  } catch { /* malformed JSON — render with empty steps */ }
  dispatch({ type: "SPINNER_STOP" });
  dispatch({
    type: "PLAN_READY_PROPOSED",
    planId: evt.planId,
    runId: evt.runId,
    objective: evt.planObjective ?? "",
    steps,
    scopeNotes: evt.planScopeNotes,
  });
}

export function handleStagedDiffsReadyExported(
  evt: ZoneStructuredProgressEvent,
  dispatch: Dispatch<StoreAction>
): void {
  if (!evt.approvalId) return;
  let files: StagedFile[] = [];
  try {
    if (evt.stagedFilesJson) files = JSON.parse(evt.stagedFilesJson);
  } catch { /* malformed JSON — render with empty files */ }
  dispatch({ type: "SPINNER_STOP" });
  dispatch({
    type: "STAGED_DIFFS_PROPOSED",
    approvalId: evt.approvalId,
    runId: evt.runId ?? "",
    files,
    verificationSummary: evt.stagedVerificationSummary ?? "",
    trigger: evt.stagedTrigger ?? "natural_completion",
  });
}

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

    function handleThinkingEvent(evt: ZoneStructuredProgressEvent): void {
      const text = evt.text ?? evt.title ?? "";
      if (!text) return;
      dispatch({ type: "TRANSCRIPT_ADD_THINKING", text });
    }

    function handleAgentLoopStart(_evt: ZoneStructuredProgressEvent): void {
      dispatch({ type: "SPINNER_START", label: SPINNER_LABEL_STARTING });
    }

    function handleAgentLoopComplete(evt: ZoneStructuredProgressEvent): void {
      flushBuffer(localBuffer, debounceTimer, dispatch);
      dispatch({ type: "NARRATION_COMMIT" });
      // Update iter/cost to final values if provided, then mark run done
      const iterCount = evt.iter_count ?? evt.iter ?? 0;
      const cost = evt.cumulativeCost ?? 0;
      void buildLoopCompleteSummary; // retain import for future use
      if (iterCount > 0) dispatch({ type: "STATUS_UPDATE", iter: iterCount, costUsd: cost });
      const detail = (evt as { detail?: string }).detail ?? "";
      if (detail.trim()) dispatch({ type: "ASSISTANT_FINAL", text: detail.trim() });
      dispatch({ type: "RUN_DONE" });
    }

    function handleRunSummary(evt: ZoneStructuredProgressEvent): void {
      flushBuffer(localBuffer, debounceTimer, dispatch);
      dispatch({ type: "NARRATION_COMMIT" });
      void buildRunSummary; // retain import for future use
      if (evt.cost) dispatch({ type: "STATUS_UPDATE", costUsd: evt.cost.totalUsd });
      dispatch({ type: "RUN_DONE" });
    }

    function handleToolCall(evt: ZoneStructuredProgressEvent): void {
      const title = evt.title ?? "";
      // Skip spurious progress strings (e.g. "[agent_loop] Iteration N/24"):
      // real tool calls either carry toolName or have a "[tool]"-prefixed title
      if (!evt.toolName && !title.startsWith("[tool]")) return;
      flushBuffer(localBuffer, debounceTimer, dispatch);
      dispatch({ type: "NARRATION_COMMIT" });
      // onToolCall embeds tool name and args in title as "[tool] name: cmd".
      // Parse it so Transcript renders "read_file  src/foo.ts  ✓" not "[tool] read_file: src/foo.ts  ✓".
      let toolName = evt.toolName ?? title;
      let args = evt.detail ?? "";
      if (!evt.toolName && title.startsWith("[tool] ")) {
        const stripped = title.slice(7);
        const sep = stripped.indexOf(": ");
        if (sep !== -1) {
          toolName = stripped.slice(0, sep);
          args = stripped.slice(sep + 2);
        } else {
          toolName = stripped;
        }
      }
      dispatch({ type: "TOOL_CALL_OPEN", toolName, args, patch: evt.patch });
    }

    function handleToolResult(evt: ZoneStructuredProgressEvent): void {
      dispatch({ type: "TOOL_RESULT_PUSH", ok: evt.status !== "error", detail: evt.detail ?? evt.title ?? "" });
      dispatch({ type: "TOOL_CALL_CLOSE" });
    }

    function handleTerminalOutput(evt: ZoneStructuredProgressEvent): void {
      dispatch({ type: "TOOL_RESULT_PUSH", ok: true, detail: evt.detail ?? "" });
    }

    function handleTerminalDone(evt: ZoneStructuredProgressEvent): void {
      if (evt.exitCode != null && evt.exitCode !== 0) {
        dispatch({ type: "TOOL_RESULT_PUSH", ok: false, detail: `exit ${evt.exitCode}` });
      }
      dispatch({ type: "TOOL_CALL_CLOSE" });
    }

    function handleSpinnerUpdate(evt: ZoneStructuredProgressEvent): void {
      dispatch({ type: "SPINNER_UPDATE", label: evt.title ?? "" });
    }

    function handleIterCost(evt: ZoneStructuredProgressEvent): void {
      dispatch({ type: "STATUS_UPDATE", iter: evt.iter ?? 0, costUsd: evt.cumulativeCost ?? 0 });
    }

    function handleTokenBudget(evt: ZoneStructuredProgressEvent): void {
      const ratio = evt.tokenBudgetRatio ?? 0;
      dispatch({ type: "STATUS_UPDATE", tokenBudgetRatio: ratio, ...(evt.cumulativeTokens != null ? { tokens: evt.cumulativeTokens } : {}) });
      if (ratio >= 0.7) {
        dispatch({
          type: "TOAST_PUSH",
          entry: {
            id: randomUUID(),
            message: ratio >= 0.9 ? "Token budget critical (>90%)" : "Token budget warning (>70%)",
            level: ratio >= 0.9 ? "error" : "warning",
          },
        });
      }
    }

    function handlePatchRejected(evt: ZoneStructuredProgressEvent): void {
      dispatch({ type: "ERROR_LINE", text: evt.title ?? "Patch rejected" });
    }

    function handlePhaseChanged(evt: ZoneStructuredProgressEvent): void {
      flushBuffer(localBuffer, debounceTimer, dispatch);
      dispatch({ type: "PHASE_MARKER", phase: String(evt.phase ?? "") });
    }

    function handleLoopWarning(evt: ZoneStructuredProgressEvent): void {
      dispatch({
        type: "TOAST_PUSH",
        entry: { id: randomUUID(), message: evt.title ?? "Loop warning", level: "warning" },
      });
    }

    function handleLoopDetected(evt: ZoneStructuredProgressEvent): void {
      dispatch({ type: "SPINNER_STOP" });
      dispatch({ type: "ERROR_LINE", text: evt.title ?? "Loop detected" });
    }

    function handleCommandApproval(evt: ZoneStructuredProgressEvent): void {
      if (!evt.approvalId) return;
      const command = evt.command ?? evt.title ?? "";
      const prefixes = trustedPrefixesRef.current ?? [];
      const trusted = prefixes.some(
        p => command.trim() === p || command.trim().startsWith(p + " ")
      );
      if (trusted) {
        resolveCommandApproval({ approvalId: evt.approvalId, runId: evt.runId ?? "", approved: true });
        return;
      }
      flushBuffer(localBuffer, debounceTimer, dispatch);
      dispatch({ type: "PENDING_APPROVAL_SET", approvalId: evt.approvalId, runId: evt.runId ?? "", command });
    }

    const handleEditApprovalEvt = (evt: ZoneStructuredProgressEvent): void => {
      flushBuffer(localBuffer, debounceTimer, dispatch);
      handleEditApproval(evt, dispatch);
    };

    const handleTrustApproval = (evt: ZoneStructuredProgressEvent): void => {
      flushBuffer(localBuffer, debounceTimer, dispatch);
      dispatch({
        type: "PENDING_APPROVAL_SET",
        approvalId: evt.runId ?? "",
        runId: evt.runId ?? "",
        command: evt.projectPath ?? "",
        kind: "trust",
      });
    };

    function handlePlanReadyForApproval(evt: ZoneStructuredProgressEvent): void {
      handlePlanReadyForApprovalExported(evt, dispatch);
    }

    function handleRevisionProposed(evt: ZoneStructuredProgressEvent): void {
      if (modeRef.current === "plan") {
        dispatch({
          type: "PLAN_PROPOSED",
          revisionId: (evt as any).revisionId ?? "",
          runId: (evt as any).runId ?? "",
          revisionType: (evt as any).revisionType ?? "mixed",
          revisionReason: (evt as any).revisionReason ?? "",
          originalPlan: (evt as any).revisionOriginalPlan ?? "",
          revisedPlanSummary: (evt as any).revisionRevisedPlanSummary ?? "",
          ...((evt as any).revisionMissingFiles
            ? { missingFiles: (evt as any).revisionMissingFiles } : {}),
          ...((evt as any).revisionUnnecessaryFiles
            ? { unnecessaryFiles: (evt as any).revisionUnnecessaryFiles } : {}),
        });
      } else {
        if (evt.revisionId) {
          resolveRevisionApproval({ revisionId: evt.revisionId, runId: evt.runId, decision: "reject" });
        }
        dispatch({ type: "ERROR_LINE", text: "⚠ Scope revision proposed — auto-rejected." });
      }
    }

    function handleRunFailed(evt: ZoneStructuredProgressEvent): void {
      flushBuffer(localBuffer, debounceTimer, dispatch);
      dispatch({ type: "ERROR_LINE", text: evt.userMessage ?? "Provider error." });
      dispatch({ type: "RUN_FAILED" });
    }

    const handlePlanReady = handlePlanReadyForApproval;
    bus.on("run_failed", handleRunFailed);
    bus.on("plan_ready_for_approval", handlePlanReady);
    bus.on("agent_loop_start", handleAgentLoopStart);
    bus.on("agent_loop_complete", handleAgentLoopComplete);
    bus.on("run_summary", handleRunSummary);
    bus.on("narration", handleTextEvent);
    bus.on("thinking", handleThinkingEvent);
    bus.on("chat_chunk", handleTextEvent);
    bus.on("chat_response", handleTextEvent);
    bus.on("tool_call", handleToolCall);
    bus.on("tool_result", handleToolResult);
    bus.on("terminal_output", handleTerminalOutput);
    bus.on("terminal_done", handleTerminalDone);
    bus.on("ranking_context", handleSpinnerUpdate);
    bus.on("generating_patch", handleSpinnerUpdate);
    bus.on("verification", handleSpinnerUpdate);
    bus.on("verification_investigating", handleSpinnerUpdate);
    bus.on("verification_fixing", handleSpinnerUpdate);
    bus.on("verification_fixed", handleSpinnerUpdate);
    bus.on("llm_retry_in_progress", handleSpinnerUpdate);
    bus.on("scope_audit_started", handleSpinnerUpdate);
    bus.on("iter_cost_update", handleIterCost);
    bus.on("token_budget_status", handleTokenBudget);
    bus.on("patch_rejected", handlePatchRejected);
    bus.on("phase_changed", handlePhaseChanged);
    bus.on("loop_warning_emitted", handleLoopWarning);
    bus.on("loop_detected_terminal", handleLoopDetected);
    bus.on("command_approval_required", handleCommandApproval);
    bus.on("edit_approval_required", handleEditApprovalEvt);
    bus.on("trust_approval_required", handleTrustApproval);
    bus.on("scope_revision_proposed", handleRevisionProposed);

    const onStarted   = (evt: ZoneStructuredProgressEvent) => handleCompactionStarted(evt, dispatch);
    const onStatus    = (evt: ZoneStructuredProgressEvent) => handleCompactionStatus(evt, dispatch);
    const onExhausted = (evt: ZoneStructuredProgressEvent) => handleCompactionExhausted(evt, dispatch);
    const onOverflow  = (evt: unknown) => handleCompactionOverflow(evt, dispatch);
    bus.on("compaction_started",          onStarted);
    bus.on("compaction_status",           onStatus);
    bus.on("compaction_exhausted",        onExhausted);
    bus.on("compaction_overflow_warning", onOverflow);

    const onTodosInitialized = (evt: ZoneStructuredProgressEvent) => handleTodosInitialized(evt, dispatch);
    const onTodoRevised      = (evt: ZoneStructuredProgressEvent) => handleTodoRevised(evt, dispatch);
    const onTodoStatus       = (evt: ZoneStructuredProgressEvent) => handleTodoStatusChanged(evt, dispatch);
    bus.on("todos_initialized",   onTodosInitialized);
    bus.on("todo_revised",        onTodoRevised);
    bus.on("todo_status_changed", onTodoStatus);

    const onPlanGenStarted = (evt: ZoneStructuredProgressEvent) => handlePlanGenerationStarted(evt, dispatch);
    bus.on("plan_generation_started", onPlanGenStarted);

    const onStagedDiffsReady = (evt: ZoneStructuredProgressEvent) =>
      handleStagedDiffsReadyExported(evt, dispatch);
    bus.on("staged_diffs_ready_for_approval", onStagedDiffsReady);

    const onPostExecuteDiffs = (evt: ZoneStructuredProgressEvent): void => {
      if (!evt.stagedFilesJson) return;
      let files: StagedFile[] = [];
      try { files = JSON.parse(evt.stagedFilesJson); } catch { return; }
      if (files.length > 0) dispatch({ type: "POST_EXECUTE_DIFFS", files });
    };
    bus.on("post_execute_diffs", onPostExecuteDiffs);

    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      bus.off("run_failed", handleRunFailed);
      bus.off("plan_ready_for_approval", handlePlanReady);
      bus.off("agent_loop_start", handleAgentLoopStart);
      bus.off("agent_loop_complete", handleAgentLoopComplete);
      bus.off("run_summary", handleRunSummary);
      bus.off("narration", handleTextEvent);
      bus.off("thinking", handleThinkingEvent);
      bus.off("chat_chunk", handleTextEvent);
      bus.off("chat_response", handleTextEvent);
      bus.off("tool_call", handleToolCall);
      bus.off("tool_result", handleToolResult);
      bus.off("terminal_output", handleTerminalOutput);
      bus.off("terminal_done", handleTerminalDone);
      bus.off("ranking_context", handleSpinnerUpdate);
      bus.off("generating_patch", handleSpinnerUpdate);
      bus.off("verification", handleSpinnerUpdate);
      bus.off("verification_investigating", handleSpinnerUpdate);
      bus.off("verification_fixing", handleSpinnerUpdate);
      bus.off("verification_fixed", handleSpinnerUpdate);
      bus.off("llm_retry_in_progress", handleSpinnerUpdate);
      bus.off("scope_audit_started", handleSpinnerUpdate);
      bus.off("iter_cost_update", handleIterCost);
      bus.off("token_budget_status", handleTokenBudget);
      bus.off("patch_rejected", handlePatchRejected);
      bus.off("phase_changed", handlePhaseChanged);
      bus.off("loop_warning_emitted", handleLoopWarning);
      bus.off("loop_detected_terminal", handleLoopDetected);
      bus.off("command_approval_required", handleCommandApproval);
      bus.off("edit_approval_required", handleEditApprovalEvt);
      bus.off("trust_approval_required", handleTrustApproval);
      bus.off("scope_revision_proposed", handleRevisionProposed);
      bus.off("compaction_started",          onStarted);
      bus.off("compaction_status",           onStatus);
      bus.off("compaction_exhausted",        onExhausted);
      bus.off("compaction_overflow_warning", onOverflow);
      bus.off("todos_initialized",   onTodosInitialized);
      bus.off("todo_revised",        onTodoRevised);
      bus.off("todo_status_changed", onTodoStatus);
      bus.off("plan_generation_started", onPlanGenStarted);
      bus.off("staged_diffs_ready_for_approval", onStagedDiffsReady);
      bus.off("post_execute_diffs", onPostExecuteDiffs);
    };
  }, [bus, dispatch]);
}
