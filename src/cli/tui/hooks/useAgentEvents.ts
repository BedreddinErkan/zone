import { useEffect, useRef, type Dispatch, type MutableRefObject } from "react";
import { randomUUID } from "node:crypto";
import type { EventBus } from "../../eventBus.js";
import type { StoreAction } from "../store.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import { resolveCommandApproval } from "../../../api/commandApprovals.js";
import { resolveRevisionApproval } from "../../../llm/revisionApprovals.js";
import { buildLoopCompleteSummary, buildRunSummary } from "../../../core/eventProcessors.js";
// buildLoopCompleteSummary / buildRunSummary kept for future telemetry; run text no longer stored in transcript

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
    dispatch({ type: "NARRATION_APPEND", text: localBuffer.current });
    localBuffer.current = "";
  }
}

export function useAgentEvents(bus: EventBus | undefined, dispatch: Dispatch<StoreAction>): void {
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
        dispatch({ type: "NARRATION_APPEND", text: localBuffer.current });
        localBuffer.current = "";
        debounceTimer.current = null;
      }, 200);
    }

    function handleAgentLoopStart(_evt: ZoneStructuredProgressEvent): void {
      dispatch({ type: "SPINNER_START", label: "Starting…" });
    }

    function handleAgentLoopComplete(evt: ZoneStructuredProgressEvent): void {
      flushBuffer(localBuffer, debounceTimer, dispatch);
      // Update iter/cost to final values if provided, then mark run done
      const iterCount = evt.iter_count ?? evt.iter ?? 0;
      const cost = evt.cumulativeCost ?? 0;
      void buildLoopCompleteSummary; // retain import for future use
      if (iterCount > 0) dispatch({ type: "STATUS_UPDATE", iter: iterCount, costUsd: cost });
      dispatch({ type: "RUN_DONE" });
    }

    function handleRunSummary(evt: ZoneStructuredProgressEvent): void {
      flushBuffer(localBuffer, debounceTimer, dispatch);
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
      dispatch({ type: "TOOL_CALL_OPEN", toolName: evt.toolName ?? title, args: evt.detail ?? "" });
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
      dispatch({ type: "STATUS_UPDATE", tokenBudgetRatio: ratio });
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
      if (evt.approvalId) {
        resolveCommandApproval({ approvalId: evt.approvalId, approved: false, runId: evt.runId });
      }
      dispatch({
        type: "ERROR_LINE",
        text: "⚠ Command approval required — auto-rejected (approval UI not yet implemented).",
      });
    }

    function handleRevisionProposed(evt: ZoneStructuredProgressEvent): void {
      if (evt.revisionId) {
        resolveRevisionApproval({ revisionId: evt.revisionId, runId: evt.runId, decision: "reject" });
      }
      dispatch({
        type: "ERROR_LINE",
        text: "⚠ Scope revision proposed — auto-rejected.",
      });
    }

    bus.on("agent_loop_start", handleAgentLoopStart);
    bus.on("agent_loop_complete", handleAgentLoopComplete);
    bus.on("run_summary", handleRunSummary);
    bus.on("narration", handleTextEvent);
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
    bus.on("scope_revision_proposed", handleRevisionProposed);

    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      bus.off("agent_loop_start", handleAgentLoopStart);
      bus.off("agent_loop_complete", handleAgentLoopComplete);
      bus.off("run_summary", handleRunSummary);
      bus.off("narration", handleTextEvent);
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
      bus.off("scope_revision_proposed", handleRevisionProposed);
    };
  }, [bus, dispatch]);
}
