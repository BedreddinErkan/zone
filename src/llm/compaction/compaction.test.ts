import { describe, it, expect } from "vitest";
import { ContextCompactor } from "./ContextCompactor.js";
import { classifyTurns } from "./classifyTurns.js";
import {
  TurnClass,
  CompactionExhaustedError,
  type ToolCallRecord,
} from "./types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHistory(roles: string[]): ChatCompletionMessageParam[] {
  return roles.map((role) => {
    if (role === "system") return { role: "system", content: "sys" };
    if (role === "user") return { role: "user", content: "task" };
    if (role === "assistant") return { role: "assistant", content: "ok" };
    if (role === "tool") {
      return { role: "tool", tool_call_id: "call_x", content: "result" };
    }
    throw new Error(`unknown role: ${role}`);
  });
}

function makeHistoryWithToolCall(
  toolName: string,
  callId: string,
  toolSuccess: boolean
): {
  history: ChatCompletionMessageParam[];
  log: Array<ToolCallRecord>;
} {
  const history: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: toolName, arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: callId, content: "output" },
    { role: "assistant", content: "summary" },
    { role: "user", content: "follow up" },
    { role: "assistant", content: "done" },
  ];
  const log: Array<ToolCallRecord> = [
    { tool: toolName, args: {}, result: "output", success: toolSuccess },
  ];
  return { history, log };
}

/** Build a compactor that has already been compacted N times via side-channel. */
function compactorWithCount(n: number): ContextCompactor {
  const c = new ContextCompactor();
  // Drive it past threshold with synthetic history that always has candidates.
  const history: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    // enough candidate turns in the middle
    { role: "assistant", content: "a1" },
    { role: "assistant", content: "a2" },
    { role: "assistant", content: "a3" },
    { role: "assistant", content: "a4" },
    { role: "assistant", content: "a5" },
  ];
  for (let i = 0; i < n; i++) {
    c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 800_000,
      effectiveCap: 800_000,
    });
  }
  return c;
}

// ---------------------------------------------------------------------------
// ContextCompactor — trigger tests
// ---------------------------------------------------------------------------

describe("ContextCompactor.checkAndMaybeCompact", () => {
  it("returns under_threshold when usage < 75% of cap", () => {
    const c = new ContextCompactor();
    const result = c.checkAndMaybeCompact({
      responseInput: [],
      toolCallLog: [],
      currentUsage: 500_000,
      effectiveCap: 800_000,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("under_threshold");
  });

  it("returns no_candidates when threshold met but all turns are verbatim", () => {
    const c = new ContextCompactor();
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const result = c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("no_candidates");
  });

  it("returns compacted and increments count when threshold met and candidates exist", () => {
    const c = new ContextCompactor();
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "candidate-1" }, // candidate: not recency
      { role: "assistant", content: "candidate-2" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const result = c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
    });
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(result.warning).toBeUndefined();
  });

  it("emits warning string on 3rd compaction", () => {
    const c = compactorWithCount(2);
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "c1" },
      { role: "assistant", content: "c2" },
      { role: "assistant", content: "c3" },
      { role: "assistant", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const result = c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 800_000,
      effectiveCap: 800_000,
    });
    expect(result.compacted).toBe(true);
    expect(result.warning).toMatch(/compacted 3 times/);
  });

  it("throws CompactionExhaustedError on 6th call when MAX_COMPACTIONS=5 reached", () => {
    const c = compactorWithCount(5);
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "c1" },
      { role: "assistant", content: "c2" },
      { role: "assistant", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    expect(() =>
      c.checkAndMaybeCompact({
        responseInput: history,
        toolCallLog: [],
        currentUsage: 800_000,
        effectiveCap: 800_000,
      })
    ).toThrow(CompactionExhaustedError);
  });
});

// ---------------------------------------------------------------------------
// classifyTurns tests
// ---------------------------------------------------------------------------

describe("classifyTurns", () => {
  it("initial user task is always verbatim", () => {
    const history = makeHistory(["system", "user", "assistant", "user", "assistant"]);
    const result = classifyTurns(history, []);
    expect(result[1].class).toBe(TurnClass.VERBATIM);
    expect(result[1].reason).toBe("initial_task");
  });

  it("last 3 turns are always verbatim", () => {
    const history = makeHistory([
      "system",
      "user",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
    ]);
    const result = classifyTurns(history, []);
    const len = result.length;
    expect(result[len - 1].class).toBe(TurnClass.VERBATIM);
    expect(result[len - 2].class).toBe(TurnClass.VERBATIM);
    expect(result[len - 3].class).toBe(TurnClass.VERBATIM);
  });

  it("assistant turn calling apply_patch is verbatim (protected_tool)", () => {
    // History must be long enough that idx 2 is outside the recency window (last 3).
    // With 7 turns: recency window covers idx 4,5,6 — idx 2 is a candidate unless protected.
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "apply_patch", arguments: "{}" },
          },
        ],
      },
      { role: "user", content: "follow-up" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const result = classifyTurns(history, []);
    expect(result[2].class).toBe(TurnClass.VERBATIM);
    expect(result[2].reason).toBe("protected_tool");
  });

  it("tool result for apply_patch success is verbatim (applied_protected_result)", () => {
    const { history, log } = makeHistoryWithToolCall(
      "apply_patch",
      "call_patch",
      true
    );
    // history[3] is the tool result, which is NOT in the recency window
    // (history length is 7, recency window is last 3 = indices 4,5,6)
    const result = classifyTurns(history, log);
    expect(result[3].class).toBe(TurnClass.VERBATIM);
    expect(result[3].reason).toBe("applied_protected_result");
  });

  it("tool result for apply_patch failure is verbatim (rollback_context)", () => {
    const { history, log } = makeHistoryWithToolCall(
      "apply_patch",
      "call_fail",
      false
    );
    const result = classifyTurns(history, log);
    expect(result[3].class).toBe(TurnClass.VERBATIM);
    expect(result[3].reason).toBe("rollback_context");
  });

  it("read_file tool_call at index 2 of 10-turn history is a candidate", () => {
    // 10 turns: [system, user, assistant(read_file), tool, a, u, a, u, a, u]
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_rf",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_rf", content: "file content" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a4" },
      { role: "user", content: "u4" },
    ];
    const log: Array<ToolCallRecord> = [
      { tool: "read_file", args: {}, result: "file content", success: true },
    ];
    const result = classifyTurns(history, log);
    expect(result[2].class).toBe(TurnClass.CANDIDATE);
    expect(result[2].reason).toBe("default_candidate");
  });

  it("assistant reasoning turn (no tool_calls) at index 2 of 10-turn history is a candidate", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "just thinking" }, // no tool_calls
      { role: "user", content: "ok" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a4" },
      { role: "user", content: "u4" },
      { role: "assistant", content: "a5" },
      { role: "user", content: "u5" },
    ];
    const result = classifyTurns(history, []);
    expect(result[2].class).toBe(TurnClass.CANDIDATE);
    expect(result[2].reason).toBe("default_candidate");
  });
});
