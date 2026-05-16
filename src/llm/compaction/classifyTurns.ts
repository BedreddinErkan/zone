import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { TurnClass, type ClassifiedTurn, type ToolCallRecord } from "./types.js";

const PROTECTED_TOOLS = new Set([
  "apply_patch",
  "update_memory",
  "Task",
]);

const RECENCY_WINDOW = 3;

function firstUserIndex(history: ChatCompletionMessageParam[]): number {
  return history.findIndex((t) => t.role === "user");
}

export function classifyTurns(
  history: ChatCompletionMessageParam[],
  toolCallLog: Array<ToolCallRecord>
): ClassifiedTurn[] {
  const total = history.length;
  const firstUser = firstUserIndex(history);

  const recById = new Map<string, ToolCallRecord>();
  for (const r of toolCallLog) recById.set(r.id, r);

  // Pass 1: base classification
  const classified: ClassifiedTurn[] = history.map((turn, idx) => {
    if (turn.role === "system") {
      return { index: idx, class: TurnClass.VERBATIM, reason: "system" };
    }
    if (turn.role === "user" && idx === firstUser) {
      return { index: idx, class: TurnClass.VERBATIM, reason: "initial_task" };
    }
    if (idx >= total - RECENCY_WINDOW) {
      return { index: idx, class: TurnClass.VERBATIM, reason: "recency" };
    }
    if (turn.role === "assistant" && turn.tool_calls?.length) {
      const hasProtected = turn.tool_calls.some(
        (c) => c.type === "function" && PROTECTED_TOOLS.has(c.function.name)
      );
      if (hasProtected) {
        return { index: idx, class: TurnClass.VERBATIM, reason: "protected_tool" };
      }
    }
    if (turn.role === "tool") {
      const rec = recById.get(turn.tool_call_id);
      if (rec !== undefined) {
        if (PROTECTED_TOOLS.has(rec.tool) && rec.success) {
          return { index: idx, class: TurnClass.VERBATIM, reason: "applied_protected_result" };
        }
        if (rec.tool === "apply_patch" && !rec.success) {
          return { index: idx, class: TurnClass.VERBATIM, reason: "rollback_context" };
        }
      }
    }
    return { index: idx, class: TurnClass.CANDIDATE, reason: "default_candidate" };
  });

  // Pass 2: pair propagation — ensure no orphan tool_call/tool_result across candidate boundary.
  // Build callId → assistantIdx and callId → toolResultIdx lookup maps.
  const callIdToAssistantIdx = new Map<string, number>();
  const callIdToToolResultIdx = new Map<string, number>();
  history.forEach((turn, idx) => {
    if (turn.role === "assistant" && turn.tool_calls?.length) {
      for (const call of turn.tool_calls) {
        callIdToAssistantIdx.set(call.id, idx);
      }
    }
    if (turn.role === "tool") {
      callIdToToolResultIdx.set(turn.tool_call_id, idx);
    }
  });

  // Fixed-point loop: each iteration can only flip CANDIDATE → VERBATIM, so it
  // terminates in at most history.length passes. Safety counter guards against bugs.
  let changed = true;
  let safety = history.length + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const c of classified) {
      if (c.class !== TurnClass.VERBATIM) continue;
      const turn = history[c.index];

      // VERBATIM tool result → its assistant call must also be VERBATIM
      if (turn.role === "tool") {
        const aIdx = callIdToAssistantIdx.get(turn.tool_call_id);
        if (aIdx !== undefined && classified[aIdx].class !== TurnClass.VERBATIM) {
          classified[aIdx] = {
            index: aIdx,
            class: TurnClass.VERBATIM,
            reason: "pair_with_verbatim_tool_result",
          };
          changed = true;
        }
      }

      // VERBATIM assistant with tool_calls → all its tool results must also be VERBATIM
      if (turn.role === "assistant" && turn.tool_calls?.length) {
        for (const call of turn.tool_calls) {
          const rIdx = callIdToToolResultIdx.get(call.id);
          if (rIdx !== undefined && classified[rIdx].class !== TurnClass.VERBATIM) {
            classified[rIdx] = {
              index: rIdx,
              class: TurnClass.VERBATIM,
              reason: "pair_with_verbatim_tool_call",
            };
            changed = true;
          }
        }
      }
    }
  }

  return classified;
}
