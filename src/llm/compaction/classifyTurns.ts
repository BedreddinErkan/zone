import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { TurnClass, type ClassifiedTurn, type ToolCallRecord } from "./types.js";

const PROTECTED_TOOLS = new Set([
  "apply_patch",
  "update_memory",
  "verify_visual",
  "Task",
]);

const RECENCY_WINDOW = 3;

function firstUserIndex(history: ChatCompletionMessageParam[]): number {
  return history.findIndex((t) => t.role === "user");
}

/**
 * Build a callId → ToolCallRecord map from the log for O(1) lookup.
 * Now that log entries carry `id`, this is exact — no name-based ambiguity.
 */
function buildRecordById(
  toolCallLog: Array<ToolCallRecord>
): Map<string, ToolCallRecord> {
  const map = new Map<string, ToolCallRecord>();
  for (const rec of toolCallLog) {
    map.set(rec.id, rec);
  }
  return map;
}

export function classifyTurns(
  history: ChatCompletionMessageParam[],
  toolCallLog: Array<ToolCallRecord>
): ClassifiedTurn[] {
  const total = history.length;
  const firstUser = firstUserIndex(history);
  const recById = buildRecordById(toolCallLog);

  return history.map((turn, idx) => {
    // System prompt: always verbatim
    if (turn.role === "system") {
      return { index: idx, class: TurnClass.VERBATIM, reason: "system" };
    }

    // Initial user task: always verbatim
    if (turn.role === "user" && idx === firstUser) {
      return { index: idx, class: TurnClass.VERBATIM, reason: "initial_task" };
    }

    // Recency window: always verbatim
    if (idx >= total - RECENCY_WINDOW) {
      return { index: idx, class: TurnClass.VERBATIM, reason: "recency" };
    }

    // Assistant turn that called a protected tool: verbatim
    if (turn.role === "assistant" && turn.tool_calls?.length) {
      const hasProtected = turn.tool_calls.some(
        (c) => c.type === "function" && PROTECTED_TOOLS.has(c.function.name)
      );
      if (hasProtected) {
        return {
          index: idx,
          class: TurnClass.VERBATIM,
          reason: "protected_tool",
        };
      }
    }

    // Tool result turn: look up the originating log entry by call id.
    if (turn.role === "tool") {
      const rec = recById.get(turn.tool_call_id);
      if (rec !== undefined) {
        if (PROTECTED_TOOLS.has(rec.tool) && rec.success) {
          return {
            index: idx,
            class: TurnClass.VERBATIM,
            reason: "applied_protected_result",
          };
        }
        if (rec.tool === "apply_patch" && !rec.success) {
          return {
            index: idx,
            class: TurnClass.VERBATIM,
            reason: "rollback_context",
          };
        }
      }
    }

    return { index: idx, class: TurnClass.CANDIDATE, reason: "default_candidate" };
  });
}
