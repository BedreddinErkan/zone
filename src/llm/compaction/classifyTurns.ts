import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { TurnClass, type ClassifiedTurn, type ToolCallRecord } from "./types.js";

const PROTECTED_TOOLS = new Set([
  "apply_patch",
  "update_memory",
  "Task",
]);

// Audit tool surface: turns calling these are PINNED (never summarized).
const PINNED_TOOLS = new Set([
  "suggest_scope_change",
]);

const RECENCY_WINDOW = 3;

function firstUserIndex(history: ChatCompletionMessageParam[]): number {
  return history.findIndex((t) => t.role === "user");
}

// isFailure checks whether a tool result represents a real failure.
// Primary: toolCallLog success===false (structured, reliable).
// Fallback: content regex when no log record exists.
// Phase F verifier warnings (VERIFICATION WARNINGS / [VERIFY-WARN]) are excluded —
// they are informational; patches stay on disk and agent continues.
function isFailure(
  turn: ChatCompletionMessageParam,
  toolCallId: string,
  recById: Map<string, ToolCallRecord>
): boolean {
  const rec = recById.get(toolCallId);
  if (rec !== undefined) {
    return rec.success === false;
  }
  const content = typeof turn.content === "string" ? turn.content : "";
  if (content.includes("VERIFICATION WARNINGS") || content.includes("[VERIFY-WARN]")) return false;
  return /^(Error|Failed|patch rejected|verifier failed|test.*FAIL|exit code [1-9])/im.test(content);
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
      // PINNED_TOOLS: audit artifacts — strongest preservation tier
      const hasPinned = turn.tool_calls.some(
        (c) => c.type === "function" && PINNED_TOOLS.has(c.function.name)
      );
      if (hasPinned) {
        return { index: idx, class: TurnClass.PINNED, reason: "audit_artifact", pinReason: "audit_artifact" };
      }
      // Protected tools: apply_patch, update_memory, Task
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
  // Handles both VERBATIM and PINNED: a non-CANDIDATE turn propagates its class to its pair.
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

  // Fixed-point loop: each iteration can only flip CANDIDATE → VERBATIM/PINNED, so it
  // terminates in at most history.length passes. Safety counter guards against bugs.
  let changed = true;
  let safety = history.length + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const c of classified) {
      if (c.class === TurnClass.CANDIDATE) continue;
      const turn = history[c.index];

      // Non-CANDIDATE tool result → its assistant call must also be non-CANDIDATE.
      // Propagate the same class (VERBATIM or PINNED) so PINNED audit results pin their caller.
      if (turn.role === "tool") {
        const aIdx = callIdToAssistantIdx.get(turn.tool_call_id);
        if (aIdx !== undefined && classified[aIdx].class === TurnClass.CANDIDATE) {
          classified[aIdx] = {
            index: aIdx,
            class: c.class,
            reason: c.class === TurnClass.PINNED
              ? "pair_with_pinned_tool_result"
              : "pair_with_verbatim_tool_result",
            pinReason: c.pinReason,
          };
          changed = true;
        }
      }

      // Non-CANDIDATE assistant with tool_calls → all its tool results must also be non-CANDIDATE.
      if (turn.role === "assistant" && turn.tool_calls?.length) {
        for (const call of turn.tool_calls) {
          const rIdx = callIdToToolResultIdx.get(call.id);
          if (rIdx !== undefined && classified[rIdx].class === TurnClass.CANDIDATE) {
            classified[rIdx] = {
              index: rIdx,
              class: c.class,
              reason: c.class === TurnClass.PINNED
                ? "pair_with_pinned_tool_call"
                : "pair_with_verbatim_tool_call",
              pinReason: c.pinReason,
            };
            changed = true;
          }
        }
      }
    }
  }

  // Pass 3: pin recent failures.
  // Walks right-to-left and pins up to FAILURE_PIN_DEPTH CANDIDATE tool results
  // whose toolCallLog record has success===false, or whose content matches failure patterns.
  // Phase F verifier warnings are excluded (see isFailure).
  const failurePinDepth = Number(process.env.ZONE_FAILURE_PIN_DEPTH ?? 3);
  let failuresFound = 0;
  for (let i = classified.length - 1; i >= 0 && failuresFound < failurePinDepth; i--) {
    const c = classified[i];
    if (c.class !== TurnClass.CANDIDATE) continue;
    const turn = history[i];
    if (turn.role !== "tool") continue;
    const toolCallId = (turn as { tool_call_id?: string }).tool_call_id;
    if (!toolCallId) continue;
    if (!isFailure(turn, toolCallId, recById)) continue;

    classified[i] = { index: i, class: TurnClass.PINNED, reason: "recent_failure", pinReason: "recent_failure" };

    const aIdx = callIdToAssistantIdx.get(toolCallId);
    if (aIdx !== undefined && classified[aIdx].class === TurnClass.CANDIDATE) {
      classified[aIdx] = { index: aIdx, class: TurnClass.PINNED, reason: "recent_failure", pinReason: "recent_failure" };
    }

    failuresFound++;
  }

  return classified;
}
