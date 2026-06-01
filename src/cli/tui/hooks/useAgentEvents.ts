import { useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject } from "react";
import { randomUUID } from "node:crypto";
import type { EventBus } from "../../eventBus.js";
import type { StoreAction, TuiMode } from "../store.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import { resolveCommandApproval } from "../../../api/commandApprovals.js";
import { resolveRevisionApproval } from "../../../llm/revisionApprovals.js";
import { buildLoopCompleteSummary, buildRunSummary } from "../../../core/eventProcessors.js";
// buildLoopCompleteSummary / buildRunSummary kept for future telemetry; run text no longer stored in transcript

export function formatCompactionNarration(opts: {
  tokensBefore: number;
  tokensAfter: number;
  savedTokens: number;
  count: number;
}): string {
  const { tokensBefore, tokensAfter, savedTokens, count } = opts;
  const pct = tokensBefore > 0 ? Math.round((savedTokens / tokensBefore) * 100) : 0;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return `Context compacted: ~${k(tokensBefore)} → ~${k(tokensAfter)} tokens (−${pct}%, #${count})`;
}

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

    function handleAgentLoopStart(_evt: ZoneStructuredProgressEvent): void {
      dispatch({ type: "SPINNER_START", label: "Starting…" });
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

    const onStarted   = (evt: ZoneStructuredProgressEvent) => handleCompactionStarted(evt, dispatch);
    const onStatus    = (evt: ZoneStructuredProgressEvent) => handleCompactionStatus(evt, dispatch);
    const onExhausted = (evt: ZoneStructuredProgressEvent) => handleCompactionExhausted(evt, dispatch);
    const onOverflow  = (evt: unknown) => handleCompactionOverflow(evt, dispatch);
    bus.on("compaction_started",          onStarted);
    bus.on("compaction_status",           onStatus);
    bus.on("compaction_exhausted",        onExhausted);
    bus.on("compaction_overflow_warning", onOverflow);

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
      bus.off("compaction_started",          onStarted);
      bus.off("compaction_status",           onStatus);
      bus.off("compaction_exhausted",        onExhausted);
      bus.off("compaction_overflow_warning", onOverflow);
    };
  }, [bus, dispatch]);
}
