import { randomUUID } from "node:crypto";
import type { StoreAction, TuiMode } from "../store.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import { formatCompactionNarration } from "../../../core/compactionNarration.js";
import { buildLoopCompleteSummary, buildRunSummary } from "../../../core/eventProcessors.js";
// buildLoopCompleteSummary / buildRunSummary kept for future telemetry; run text no longer stored in transcript
void buildLoopCompleteSummary;
void buildRunSummary;
import type { RunTodo, TodoStatus } from "../../../core/todoLifecycle.js";
import type { StagedFile } from "../../../core/fileDiff.js";
import { debugLog } from "../../../utils/logger.js";

export const SPINNER_LABEL_STARTING = "Starting…";
export const SPINNER_LABEL_PLANNING = "Planning…";

export type EventCtx = {
  trustedPrefixes: string[];
  mode: TuiMode;
};

export type ResolverIntent =
  | { kind: "resolveCommand"; approvalId: string; runId: string; approved: boolean }
  | { kind: "resolveRevision"; revisionId: string; runId: string; decision: "reject" };

export function eventToActions(
  evt: ZoneStructuredProgressEvent,
  ctx: EventCtx
): { actions: StoreAction[]; intents: ResolverIntent[] } {
  switch (evt.type) {
    case "agent_loop_start":
      return { actions: [{ type: "SPINNER_START", label: SPINNER_LABEL_STARTING }], intents: [] };

    case "agent_loop_complete": {
      const actions: StoreAction[] = [];
      actions.push({ type: "NARRATION_COMMIT" });
      const iterCount = (evt as { iter_count?: number }).iter_count ?? evt.iter ?? 0;
      const cost = (evt as { cumulativeCost?: number }).cumulativeCost ?? 0;
      if (iterCount > 0) actions.push({ type: "STATUS_UPDATE", iter: iterCount, costUsd: cost });
      const detail = (evt as { detail?: string }).detail ?? "";
      if (detail.trim()) actions.push({ type: "ASSISTANT_FINAL", text: detail.trim() });
      actions.push({ type: "RUN_DONE" });
      return { actions, intents: [] };
    }

    case "run_summary": {
      const actions: StoreAction[] = [];
      actions.push({ type: "NARRATION_COMMIT" });
      if ((evt as { cost?: { totalUsd: number } }).cost)
        actions.push({ type: "STATUS_UPDATE", costUsd: (evt as { cost: { totalUsd: number } }).cost.totalUsd });
      actions.push({ type: "RUN_DONE" });
      return { actions, intents: [] };
    }

    // narration/chat_chunk/chat_response are handled by the caller's debounce — not here
    case "narration":
    case "chat_chunk":
    case "chat_response":
      return { actions: [], intents: [] };

    case "thinking": {
      const text = evt.text ?? evt.title ?? "";
      if (!text) return { actions: [], intents: [] };
      return { actions: [{ type: "TRANSCRIPT_ADD_THINKING", text }], intents: [] };
    }

    case "tool_call": {
      const title = evt.title ?? "";
      if (!evt.toolName && !title.startsWith("[tool]")) return { actions: [], intents: [] };
      const actions: StoreAction[] = [];
      actions.push({ type: "NARRATION_COMMIT" });
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
      actions.push({ type: "TOOL_CALL_OPEN", toolName, args, patch: evt.patch });
      return { actions, intents: [] };
    }

    case "tool_result":
      return {
        actions: [
          { type: "TOOL_RESULT_PUSH", ok: evt.status !== "error", detail: evt.detail ?? evt.title ?? "" },
          { type: "TOOL_CALL_CLOSE" },
        ],
        intents: [],
      };

    case "terminal_output":
      return { actions: [{ type: "TOOL_RESULT_PUSH", ok: true, detail: evt.detail ?? "" }], intents: [] };

    case "terminal_done": {
      const actions: StoreAction[] = [];
      if (evt.exitCode != null && evt.exitCode !== 0)
        actions.push({ type: "TOOL_RESULT_PUSH", ok: false, detail: `exit ${evt.exitCode}` });
      actions.push({ type: "TOOL_CALL_CLOSE" });
      return { actions, intents: [] };
    }

    case "ranking_context":
    case "generating_patch":
    case "verification":
    case "verification_investigating":
    case "verification_fixing":
    case "verification_fixed":
    case "llm_retry_in_progress":
    case "scope_audit_started":
      return { actions: [{ type: "SPINNER_UPDATE", label: evt.title ?? "" }], intents: [] };

    case "iter_cost_update":
      return {
        actions: [{ type: "STATUS_UPDATE", iter: evt.iter ?? 0, costUsd: (evt as { cumulativeCost?: number }).cumulativeCost ?? 0 }],
        intents: [],
      };

    case "token_budget_status": {
      const ratio = evt.tokenBudgetRatio ?? 0;
      const actions: StoreAction[] = [];
      actions.push({
        type: "STATUS_UPDATE",
        tokenBudgetRatio: ratio,
        ...(evt.cumulativeTokens != null ? { tokens: evt.cumulativeTokens } : {}),
      });
      if (ratio >= 0.7) {
        actions.push({
          type: "TOAST_PUSH",
          entry: {
            id: randomUUID(),
            message: ratio >= 0.9 ? "Token budget critical (>90%)" : "Token budget warning (>70%)",
            level: ratio >= 0.9 ? "error" : "warning",
          },
        });
      }
      return { actions, intents: [] };
    }

    case "patch_rejected":
      return { actions: [{ type: "ERROR_LINE", text: evt.title ?? "Patch rejected" }], intents: [] };

    case "phase_changed":
      return { actions: [{ type: "PHASE_MARKER", phase: String(evt.phase ?? "") }], intents: [] };

    case "loop_warning_emitted":
      return {
        actions: [{ type: "TOAST_PUSH", entry: { id: randomUUID(), message: evt.title ?? "Loop warning", level: "warning" } }],
        intents: [],
      };

    case "loop_detected_terminal":
      return {
        actions: [
          { type: "SPINNER_STOP" },
          { type: "ERROR_LINE", text: evt.title ?? "Loop detected" },
        ],
        intents: [],
      };

    case "command_approval_required": {
      if (!evt.approvalId) return { actions: [], intents: [] };
      const command = evt.command ?? evt.title ?? "";
      const trusted = ctx.trustedPrefixes.some(
        p => command.trim() === p || command.trim().startsWith(p + " ")
      );
      if (trusted) {
        return {
          actions: [],
          intents: [{ kind: "resolveCommand", approvalId: evt.approvalId, runId: evt.runId ?? "", approved: true }],
        };
      }
      return {
        actions: [{ type: "PENDING_APPROVAL_SET", approvalId: evt.approvalId, runId: evt.runId ?? "", command }],
        intents: [],
      };
    }

    case "edit_approval_required": {
      const filePath = evt.filePath ?? (evt as { command?: string }).command ?? "";
      const approvalId = evt.approvalId ?? "";
      if (!approvalId) return { actions: [], intents: [] };
      return {
        actions: [{ type: "PENDING_APPROVAL_SET", approvalId, runId: evt.runId ?? "", command: filePath, kind: "edit" }],
        intents: [],
      };
    }

    case "trust_approval_required":
      return {
        actions: [{
          type: "PENDING_APPROVAL_SET",
          approvalId: evt.runId ?? "",
          runId: evt.runId ?? "",
          command: evt.projectPath ?? "",
          kind: "trust",
        }],
        intents: [],
      };

    case "user_question_required": {
      const questionId = evt.questionId ?? "";
      const question = evt.question ?? "";
      // A question with no handle can never be resolved, and the park has no
      // timeout — dropping it here would hang the TUI in awaiting_input with
      // nothing to answer. Ignore it and let the loop's own teardown unpark.
      if (!questionId || !question) return { actions: [], intents: [] };
      return {
        actions: [{ type: "USER_QUESTION_ASKED", questionId, runId: evt.runId ?? "", question }],
        intents: [],
      };
    }

    case "scope_revision_proposed": {
      if (ctx.mode === "plan") {
        return {
          actions: [{
            type: "PLAN_PROPOSED",
            revisionId: (evt as any).revisionId ?? "",
            runId: (evt as any).runId ?? "",
            revisionType: (evt as any).revisionType ?? "mixed",
            revisionReason: (evt as any).revisionReason ?? "",
            originalPlan: (evt as any).revisionOriginalPlan ?? "",
            revisedPlanSummary: (evt as any).revisionRevisedPlanSummary ?? "",
            ...((evt as any).revisionMissingFiles ? { missingFiles: (evt as any).revisionMissingFiles } : {}),
            ...((evt as any).revisionUnnecessaryFiles ? { unnecessaryFiles: (evt as any).revisionUnnecessaryFiles } : {}),
          }],
          intents: [],
        };
      }
      const intents: ResolverIntent[] = [];
      if (evt.revisionId) {
        intents.push({ kind: "resolveRevision", revisionId: evt.revisionId, runId: evt.runId, decision: "reject" });
      }
      return {
        actions: [{ type: "ERROR_LINE", text: "⚠ Scope revision proposed — auto-rejected." }],
        intents,
      };
    }

    case "run_failed":
      return {
        actions: [
          { type: "ERROR_LINE", text: (evt as { userMessage?: string }).userMessage ?? "Provider error." },
          { type: "RUN_FAILED" },
        ],
        intents: [],
      };

    case "compaction_started":
      return { actions: [{ type: "SPINNER_UPDATE", label: "Compacting context…" }], intents: [] };

    case "compaction_status": {
      const text = formatCompactionNarration({
        tokensBefore: evt.tokensBefore ?? 0,
        tokensAfter: evt.tokensAfter ?? 0,
        savedTokens: evt.savedTokens ?? 0,
        count: evt.count ?? 0,
      });
      return {
        actions: [
          { type: "SPINNER_STOP" },
          { type: "TRANSCRIPT_APPEND_NARRATION", text },
          { type: "NARRATION_COMMIT" },
        ],
        intents: [],
      };
    }

    case "compaction_exhausted":
      return {
        actions: [
          { type: "SPINNER_STOP" },
          {
            type: "TOAST_PUSH",
            entry: {
              id: randomUUID(),
              message: evt.message ?? "Context exhausted. Break this task into subtasks.",
              level: "warning",
            },
          },
        ],
        intents: [],
      };

    case "compaction_overflow_warning":
      return {
        actions: [
          { type: "SPINNER_STOP" },
          {
            type: "TOAST_PUSH",
            entry: {
              id: randomUUID(),
              message: "Context window full — no history to compact",
              level: "warning",
            },
          },
        ],
        intents: [],
      };

    case "todos_initialized":
    case "todo_revised":
      return { actions: [{ type: "TODOS_SET", todos: (evt.todos as RunTodo[]) ?? [] }], intents: [] };

    case "todo_status_changed": {
      if (!evt.todoId) return { actions: [], intents: [] };
      return {
        actions: [{ type: "TODO_STATUS_SET", todoId: evt.todoId, status: evt.todoStatus as TodoStatus }],
        intents: [],
      };
    }

    case "plan_generation_started":
      return { actions: [{ type: "SPINNER_START", label: evt.title ?? SPINNER_LABEL_PLANNING }], intents: [] };

    case "plan_ready_for_approval": {
      if (!evt.planId) return { actions: [], intents: [] };
      let steps: Array<{ title: string; description: string; filesLikely: string[] }> = [];
      try {
        if (evt.planStepsJson) steps = JSON.parse(evt.planStepsJson);
      } catch {
        // No live producer known for this today (see planApprovals.ts:97 — the
        // string is JSON.stringify'd from schema-validated data and parsed back
        // in the same synchronous call). Bare diagnostic only; deliberately not
        // threaded into a render state — see commit message.
        debugLog("[zone-plan-steps-unparsed]", JSON.stringify({
          planId: evt.planId,
          runId: evt.runId,
          payloadBytes: Buffer.byteLength(evt.planStepsJson ?? "", "utf8"),
        }));
      }
      return {
        actions: [
          { type: "SPINNER_STOP" },
          {
            type: "PLAN_READY_PROPOSED",
            planId: evt.planId,
            runId: evt.runId,
            objective: evt.planObjective ?? "",
            steps,
            scopeNotes: evt.planScopeNotes,
            noChangeReason: evt.planNoChangeReason,
            cannotVerifyReason: evt.planCannotVerifyReason,
            answerOnlyReason: evt.planAnswerOnlyReason,
            riskHints: evt.planRiskHints ?? [],
            scopeSummary: evt.planScopeSummary ?? "",
            narrative: evt.planNarrative,
            filesLikely: evt.planFilesLikely,
          },
        ],
        intents: [],
      };
    }

    case "staged_diffs_ready_for_approval": {
      if (!evt.approvalId) return { actions: [], intents: [] };
      let files: StagedFile[] = [];
      try {
        if (evt.stagedFilesJson) files = JSON.parse(evt.stagedFilesJson);
      } catch { /* malformed JSON — render with empty files */ }
      return {
        actions: [
          { type: "SPINNER_STOP" },
          {
            type: "STAGED_DIFFS_PROPOSED",
            approvalId: evt.approvalId,
            runId: evt.runId ?? "",
            files,
            verificationSummary: evt.stagedVerificationSummary ?? "",
            trigger: evt.stagedTrigger ?? "natural_completion",
          },
        ],
        intents: [],
      };
    }

    case "post_execute_diffs": {
      if (!evt.stagedFilesJson) return { actions: [], intents: [] };
      let files: StagedFile[] = [];
      try { files = JSON.parse(evt.stagedFilesJson); } catch { return { actions: [], intents: [] }; }
      if (files.length === 0) return { actions: [], intents: [] };
      return { actions: [{ type: "POST_EXECUTE_DIFFS", files }], intents: [] };
    }

    case "hook_completed": {
      if (evt.status !== "warning") return { actions: [], intents: [] };
      return {
        actions: [{
          type: "TOAST_PUSH",
          entry: {
            id: randomUUID(),
            message: evt.title ?? "[hook_blocked] Tool vetoed by PreToolUse hook",
            level: "warning",
          },
        }],
        intents: [],
      };
    }

    case "mcp_connected":
      return {
        actions: [
          { type: "TRANSCRIPT_APPEND_NARRATION", text: evt.title ?? "MCP servers connected" },
          { type: "NARRATION_COMMIT" },
        ],
        intents: [],
      };

    case "mcp_tool_called":
      // No-op: tool_call/tool_result events already render the call in the transcript.
      return { actions: [], intents: [] };

    default:
      return { actions: [], intents: [] };
  }
}
