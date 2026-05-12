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
 * Build a callId → toolName map by scanning all assistant turns.
 * Used to resolve the tool name for role:"tool" messages without
 * requiring tool_call_id on the log entries.
 */
function buildCallIdToToolName(
  history: ChatCompletionMessageParam[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const turn of history) {
    if (turn.role === "assistant" && turn.tool_calls) {
      for (const call of turn.tool_calls) {
        if (call.type === "function") {
          map.set(call.id, call.function.name);
        }
      }
    }
  }
  return map;
}

/**
 * Build a toolName → last-known success map from the log.
 * Because the log has no tool_call_id, we use last-occurrence-wins
 * per tool name — adequate for P.1 classification.
 */
function buildToolSuccessMap(
  toolCallLog: Array<ToolCallRecord>
): Map<string, boolean | undefined> {
  const map = new Map<string, boolean | undefined>();
  for (const entry of toolCallLog) {
    map.set(entry.tool, entry.success);
  }
  return map;
}

export function classifyTurns(
  history: ChatCompletionMessageParam[],
  toolCallLog: Array<ToolCallRecord>
): ClassifiedTurn[] {
  const total = history.length;
  const firstUser = firstUserIndex(history);
  const callIdToName = buildCallIdToToolName(history);
  const toolSuccess = buildToolSuccessMap(toolCallLog);

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

    // Tool result turn: check if the originating call was protected
    if (turn.role === "tool") {
      const toolName = callIdToName.get(turn.tool_call_id);
      if (toolName !== undefined) {
        const success = toolSuccess.get(toolName);
        if (PROTECTED_TOOLS.has(toolName) && success) {
          return {
            index: idx,
            class: TurnClass.VERBATIM,
            reason: "applied_protected_result",
          };
        }
        if (toolName === "apply_patch" && !success) {
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
