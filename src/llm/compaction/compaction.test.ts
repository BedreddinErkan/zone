import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextCompactor } from "./ContextCompactor.js";
import { classifyTurns } from "./classifyTurns.js";
import {
  TurnClass,
  CompactionExhaustedError,
  type ToolCallRecord,
} from "./types.js";
import type { LLMClient } from "../types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { summarize } from "./summarizer.js";

// Stub the summarizer module so tests never hit the real LLM.
vi.mock("./summarizer.js");

beforeEach(() => {
  // Re-apply default implementation after mockReset (vitest.config has mockReset: true).
  vi.mocked(summarize).mockResolvedValue({ summaryText: "mocked summary" });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal LLMClient stub — createChatCompletion is never called (summarizer is mocked). */
const stubClient: LLMClient = {
  provider: "openai",
  createChatCompletion: vi.fn(),
  createChatCompletionStream: vi.fn(),
  createEmbedding: vi.fn(),
};

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
    { id: callId, tool: toolName, args: {}, result: "output", success: toolSuccess },
  ];
  return { history, log };
}

/** Build a compactor that has already been compacted N times. */
async function compactorWithCount(n: number): Promise<ContextCompactor> {
  const c = new ContextCompactor();
  const history: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    { role: "assistant", content: "a1" },
    { role: "assistant", content: "a2" },
    { role: "assistant", content: "a3" },
    { role: "assistant", content: "a4" },
    { role: "assistant", content: "a5" },
  ];
  for (let i = 0; i < n; i++) {
    await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 800_000,
      effectiveCap: 800_000,
      client: stubClient,
    });
  }
  return c;
}

// ---------------------------------------------------------------------------
// ContextCompactor — trigger tests
// ---------------------------------------------------------------------------

describe("ContextCompactor.checkAndMaybeCompact", () => {
  it("returns under_threshold when usage < 75% of cap", async () => {
    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: [],
      toolCallLog: [],
      currentUsage: 500_000,
      effectiveCap: 800_000,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("under_threshold");
  });

  it("returns no_candidates when threshold met but all turns are verbatim", async () => {
    const c = new ContextCompactor();
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("no_candidates");
  });

  it("returns compacted and increments count when threshold met and candidates exist", async () => {
    const c = new ContextCompactor();
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "candidate-1" },
      { role: "assistant", content: "candidate-2" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
      client: stubClient,
    });
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(result.warning).toBeUndefined();
  });

  it("emits warning string on 3rd compaction", async () => {
    const c = await compactorWithCount(2);
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "c1" },
      { role: "assistant", content: "c2" },
      { role: "assistant", content: "c3" },
      { role: "assistant", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 800_000,
      effectiveCap: 800_000,
      client: stubClient,
    });
    expect(result.compacted).toBe(true);
    expect(result.warning).toMatch(/compacted 3 times/);
  });

  it("throws CompactionExhaustedError on 6th call when MAX_COMPACTIONS=5 reached", async () => {
    const c = await compactorWithCount(5);
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "c1" },
      { role: "assistant", content: "c2" },
      { role: "assistant", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    await expect(async () => {
      await c.checkAndMaybeCompact({
        responseInput: history,
        toolCallLog: [],
        currentUsage: 800_000,
        effectiveCap: 800_000,
        client: stubClient,
      });
    }).rejects.toThrow(CompactionExhaustedError);
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
    const { history, log } = makeHistoryWithToolCall("apply_patch", "call_patch", true);
    const result = classifyTurns(history, log);
    expect(result[3].class).toBe(TurnClass.VERBATIM);
    expect(result[3].reason).toBe("applied_protected_result");
  });

  it("tool result for apply_patch failure is verbatim (rollback_context)", () => {
    const { history, log } = makeHistoryWithToolCall("apply_patch", "call_fail", false);
    const result = classifyTurns(history, log);
    expect(result[3].class).toBe(TurnClass.VERBATIM);
    expect(result[3].reason).toBe("rollback_context");
  });

  it("read_file tool_call at index 2 of 10-turn history is a candidate", () => {
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
      { id: "call_rf", tool: "read_file", args: {}, result: "file content", success: true },
    ];
    const result = classifyTurns(history, log);
    expect(result[2].class).toBe(TurnClass.CANDIDATE);
    expect(result[2].reason).toBe("default_candidate");
  });

  it("assistant reasoning turn (no tool_calls) at index 2 of 10-turn history is a candidate", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "just thinking" },
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

  it("pair propagation: tool_result in recency window makes its assistant call verbatim", () => {
    // total=6, recency starts at idx 3. idx 2 (assistant+list_files) is CANDIDATE in Pass 1.
    // idx 3 (tool_result call_1) is VERBATIM by recency. Pass 2 propagates back to idx 2.
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_files", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file list" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "next" },
    ];
    const result = classifyTurns(history, []);
    expect(result[2].class).toBe(TurnClass.VERBATIM);
    expect(result[2].reason).toBe("pair_with_verbatim_tool_result");
  });

  it("pair propagation: VERBATIM protected_tool assistant makes its tool_result verbatim", () => {
    // total=7, recency starts at idx 4. idx 2 (apply_patch) is VERBATIM by protected_tool.
    // idx 3 (tool_result call_1) has no log entry → CANDIDATE in Pass 1.
    // Pass 2 propagates forward from idx 2 to idx 3.
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "apply_patch", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "applied" },
      { role: "assistant", content: "good" },
      { role: "user", content: "next" },
      { role: "assistant", content: "done" },
    ];
    // No log entry — Pass 1 leaves tool_result as CANDIDATE
    const result = classifyTurns(history, []);
    expect(result[2].class).toBe(TurnClass.VERBATIM);
    expect(result[2].reason).toBe("protected_tool");
    expect(result[3].class).toBe(TurnClass.VERBATIM);
    expect(result[3].reason).toBe("pair_with_verbatim_tool_call");
  });

  it("pair propagation: multi-call assistant where one result is in recency — both results and assistant become verbatim", () => {
    // total=7, recency starts at idx 4.
    // idx 2: assistant + [call_1, call_2]  → CANDIDATE (Pass 1)
    // idx 3: tool_result(call_1)           → CANDIDATE (Pass 1, not in recency, no log)
    // idx 4: tool_result(call_2)           → VERBATIM (recency)
    // Pass 2 round 1: idx 4 VERBATIM → flips idx 2 to pair_with_verbatim_tool_result
    // Pass 2 round 2: idx 2 VERBATIM → flips idx 3 to pair_with_verbatim_tool_call
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_files", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "files" },
      { role: "tool", tool_call_id: "call_2", content: "content" },
      { role: "user", content: "ok" },
      { role: "assistant", content: "done" },
    ];
    const result = classifyTurns(history, []);
    expect(result[2].class).toBe(TurnClass.VERBATIM);
    expect(result[2].reason).toBe("pair_with_verbatim_tool_result");
    expect(result[3].class).toBe(TurnClass.VERBATIM);
    expect(result[3].reason).toBe("pair_with_verbatim_tool_call");
    expect(result[4].class).toBe(TurnClass.VERBATIM);
    expect(result[4].reason).toBe("recency");
  });

  it("termination: large all-candidate history (20 tool pairs) completes without infinite loop", () => {
    // 20 tool pairs all outside recency, not protected, not in log → all CANDIDATE.
    // Pass 2 finds no VERBATIM tool results to propagate, exits after one no-op iteration.
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
    ];
    for (let i = 0; i < 20; i++) {
      const callId = `call_${i}`;
      history.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: callId, type: "function", function: { name: "list_files", arguments: "{}" } }],
      });
      history.push({ role: "tool", tool_call_id: callId, content: "files" });
    }
    history.push({ role: "assistant", content: "last-3" });
    history.push({ role: "user", content: "last-2" });
    history.push({ role: "assistant", content: "last-1" });
    // total=45, recency starts at idx 42
    const result = classifyTurns(history, []);
    expect(result).toHaveLength(45);
    expect(result[2].class).toBe(TurnClass.CANDIDATE);   // first pair: assistant
    expect(result[3].class).toBe(TurnClass.CANDIDATE);   // first pair: tool_result
    expect(result[40].class).toBe(TurnClass.CANDIDATE);  // last pair (i=19): assistant
    expect(result[41].class).toBe(TurnClass.CANDIDATE);  // last pair (i=19): tool_result
    expect(result[42].class).toBe(TurnClass.VERBATIM);   // recency
  });

  it("same tool called twice with different ids and success values — each resolved independently", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "apply_patch", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "apply_patch", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "ok" },
      { role: "tool", tool_call_id: "call_b", content: "error" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const log: Array<ToolCallRecord> = [
      { id: "call_a", tool: "apply_patch", args: {}, result: "ok", success: true },
      { id: "call_b", tool: "apply_patch", args: {}, result: "error", success: false },
    ];
    const result = classifyTurns(history, log);
    expect(result[3].class).toBe(TurnClass.VERBATIM);
    expect(result[3].reason).toBe("applied_protected_result");
    expect(result[4].class).toBe(TurnClass.VERBATIM);
    expect(result[4].reason).toBe("rollback_context");
  });
});

// ---------------------------------------------------------------------------
// compact() structural tests (P.2)
// ---------------------------------------------------------------------------

describe("ContextCompactor.checkAndMaybeCompact — compaction structure", () => {
  it("newResponseInput has verbatim turns in order, candidates replaced by one synthetic system turn", async () => {
    // History: [sys, user, cand1, cand2, verbatim-recency-3, verbatim-recency-2, verbatim-recency-1]
    // Indices:   0     1     2      3          4                     5                    6
    // Candidates: idx 2, 3 (not in recency window, not protected)
    // Verbatim: sys(0), initial_user(1), recency(4,5,6)
    // Expected newResponseInput: [sys, user, <synthetic>, recency-3, recency-2, recency-1]
    //   length = 7 - 2 candidates + 1 synthetic = 6
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "cand1" },
      { role: "assistant", content: "cand2" },
      { role: "assistant", content: "recency-3" },
      { role: "user", content: "recency-2" },
      { role: "assistant", content: "recency-1" },
    ];

    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
      client: stubClient,
    });

    expect(result.compacted).toBe(true);
    expect(result.newResponseInput).toBeDefined();

    const nr = result.newResponseInput!;
    // Length: 7 - 2 candidates + 1 synthetic = 6
    expect(nr).toHaveLength(6);
    // First two: verbatim system and user
    expect(nr[0]).toEqual({ role: "system", content: "sys" });
    expect(nr[1]).toEqual({ role: "user", content: "task" });
    // Third: synthetic system turn with compacted_history wrapper
    expect(nr[2].role).toBe("system");
    expect(typeof nr[2].content).toBe("string");
    expect((nr[2].content as string)).toMatch(/\[compacted_history\]/);
    expect((nr[2].content as string)).toMatch(/\[\/compacted_history\]/);
    expect((nr[2].content as string)).toContain("mocked summary");
    // Last three: recency turns preserved
    expect(nr[3]).toEqual({ role: "assistant", content: "recency-3" });
    expect(nr[4]).toEqual({ role: "user", content: "recency-2" });
    expect(nr[5]).toEqual({ role: "assistant", content: "recency-1" });
  });

  it("compactionCount increments only when compacted === true", async () => {
    const c = new ContextCompactor();
    expect(c.getCompactionCount()).toBe(0);

    // under_threshold — should not increment
    await c.checkAndMaybeCompact({
      responseInput: [],
      toolCallLog: [],
      currentUsage: 100_000,
      effectiveCap: 800_000,
    });
    expect(c.getCompactionCount()).toBe(0);

    // no_candidates — should not increment
    const allVerbatim: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    await c.checkAndMaybeCompact({
      responseInput: allVerbatim,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
    });
    expect(c.getCompactionCount()).toBe(0);

    // real compaction — should increment
    const withCandidates: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "cand" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    await c.checkAndMaybeCompact({
      responseInput: withCandidates,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
      client: stubClient,
    });
    expect(c.getCompactionCount()).toBe(1);
  });

  it("summarizer throws → returns summarizer_failed, no newResponseInput", async () => {
    vi.mocked(summarize).mockRejectedValueOnce(new Error("LLM timeout"));

    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "cand" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];

    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
      client: stubClient,
    });

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("summarizer_failed");
    expect(result.newResponseInput).toBeUndefined();
    // Count must not have incremented on failure
    expect(c.getCompactionCount()).toBe(0);
  });
});
