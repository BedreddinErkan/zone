import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextCompactor, buildFileReadManifest } from "./ContextCompactor.js";
import { classifyTurns } from "./classifyTurns.js";
import {
  TurnClass,
  CompactionExhaustedError,
  type ClassifiedTurn,
  type ToolCallRecord,
} from "./types.js";
import type { LLMClient } from "../types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { summarize, buildSummarizationPrompt } from "./summarizer.js";

// Stub only the async summarize function; keep buildSummarizationPrompt real.
vi.mock("./summarizer.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./summarizer.js")>();
  return { ...mod, summarize: vi.fn() };
});

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

  it("recurring notice absent in synthetic turn for 1st and 2nd compaction", async () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "cand" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    for (let pass = 1; pass <= 2; pass++) {
      const c = await compactorWithCount(pass - 1);
      const result = await c.checkAndMaybeCompact({
        responseInput: [...history],
        toolCallLog: [],
        currentUsage: 700_000,
        effectiveCap: 800_000,
        client: stubClient,
      });
      const syntheticTurn = result.newResponseInput?.find(
        (t) => t.role === "system" && typeof t.content === "string" && (t.content as string).includes("[compacted_history]")
      );
      expect(syntheticTurn).toBeDefined();
      expect((syntheticTurn!.content as string)).not.toContain("NOTE:");
      expect((syntheticTurn!.content as string)).not.toContain("recommend the user break");
    }
  });

  it("recurring notice present in synthetic turn for 3rd, 4th, and 5th compaction", async () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "cand" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    for (let pass = 3; pass <= 5; pass++) {
      const c = await compactorWithCount(pass - 1);
      const result = await c.checkAndMaybeCompact({
        responseInput: [...history],
        toolCallLog: [],
        currentUsage: 700_000,
        effectiveCap: 800_000,
        client: stubClient,
      });
      const syntheticTurn = result.newResponseInput?.find(
        (t) => t.role === "system" && typeof t.content === "string" && (t.content as string).includes("[compacted_history]")
      );
      expect(syntheticTurn).toBeDefined();
      const content = syntheticTurn!.content as string;
      expect(content).toContain(`compacted ${pass} time(s)`);
      expect(content).toContain("recommend the user break");
      expect(content).toContain("mocked summary");
    }
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

// ---------------------------------------------------------------------------
// Phase J.3 — File-read manifest (buildFileReadManifest)
// ---------------------------------------------------------------------------

// Helper: build assistant+tool pairs for read_file calls
function makeReadFileTurns(
  reads: Array<{ path: string; startLine: number; endLine: number }>
): ChatCompletionMessageParam[] {
  const turns: ChatCompletionMessageParam[] = [];
  for (const [i, r] of reads.entries()) {
    const id = `call_rf_${i}`;
    turns.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filePath: r.path, lineRange: [r.startLine, r.endLine] }),
          },
        },
      ],
    });
    turns.push({ role: "tool", tool_call_id: id, content: "file content" });
  }
  return turns;
}

function allCandidateClassifications(turns: ChatCompletionMessageParam[]): ClassifiedTurn[] {
  return turns.map((_, i) => ({ index: i, class: TurnClass.CANDIDATE, reason: "candidate" }));
}

describe("Phase J.3 — buildFileReadManifest", () => {
  it("aggregates read_file results into manifest", () => {
    const turns = makeReadFileTurns([
      { path: "src/foo.ts", startLine: 1, endLine: 100 },
      { path: "src/bar.ts", startLine: 50, endLine: 150 },
    ]);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(result.manifest).toContain("src/foo.ts lines 1-100");
    expect(result.manifest).toContain("src/bar.ts lines 50-150");
    expect(result.entryCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("dedupes same-range reads into 'read Nx' notation", () => {
    const turns = makeReadFileTurns([
      { path: "src/foo.ts", startLine: 1, endLine: 100 },
      { path: "src/foo.ts", startLine: 1, endLine: 100 },
    ]);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(result.manifest).toContain("(read 2x)");
    const fileLines = result.manifest.split("\n").filter((l) => l.includes("src/foo.ts"));
    expect(fileLines).toHaveLength(1);  // one manifest line for the file
  });

  it("keeps distinct ranges for the same file as separate entries", () => {
    const turns = makeReadFileTurns([
      { path: "src/foo.ts", startLine: 1, endLine: 100 },
      { path: "src/foo.ts", startLine: 200, endLine: 400 },
    ]);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(result.manifest).toContain("lines 1-100");
    expect(result.manifest).toContain("lines 200-400");
    expect(result.entryCount).toBe(1);  // one path entry, two ranges on the same line
  });

  it("caps manifest at MANIFEST_MAX_ENTRIES (20)", () => {
    const reads = Array.from({ length: 25 }, (_, i) => ({
      path: `src/file${i}.ts`,
      startLine: 1,
      endLine: 10,
    }));
    const turns = makeReadFileTurns(reads);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(result.truncated).toBe(true);
    expect(result.entryCount).toBe(20);
    expect(result.manifest).toContain("5 more entries truncated");
  });

  it("returns empty manifest when no read_file CANDIDATE results", () => {
    const turns: ChatCompletionMessageParam[] = [
      { role: "assistant", content: "just thinking" },
      { role: "user", content: "ok" },
    ];
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(result.manifest).toBe("");
    expect(result.entryCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("excludes VERBATIM reads from manifest (they're in context already)", () => {
    const turns = makeReadFileTurns([{ path: "src/foo.ts", startLine: 1, endLine: 100 }]);
    // Classify all turns as VERBATIM
    const verbatimClassifications: ClassifiedTurn[] = turns.map((_, i) => ({
      index: i,
      class: TurnClass.VERBATIM,
      reason: "recency",
    }));
    const result = buildFileReadManifest(turns, verbatimClassifications);
    expect(result.entryCount).toBe(0);
    expect(result.manifest).toBe("");
  });

  it("excludes PINNED reads from manifest (they're in context already)", () => {
    const turns = makeReadFileTurns([{ path: "src/pinned.ts", startLine: 1, endLine: 50 }]);
    const pinnedClassifications: ClassifiedTurn[] = turns.map((_, i) => ({
      index: i,
      class: TurnClass.PINNED,
      reason: "audit_artifact",
      pinReason: "audit_artifact" as const,
    }));
    const result = buildFileReadManifest(turns, pinnedClassifications);
    expect(result.entryCount).toBe(0);
  });

  it("manifest is injected into compacted_history synthetic turn", async () => {
    const readTurns = makeReadFileTurns([{ path: "src/server.ts", startLine: 1, endLine: 200 }]);
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...readTurns,                          // 2,3 — CANDIDATE read_file pair
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
    expect(result.compacted).toBe(true);
    const synth = result.newResponseInput?.find(
      (t) => t.role === "system" && typeof t.content === "string" && (t.content as string).includes("[compacted_history]")
    );
    expect(synth).toBeDefined();
    const content = synth!.content as string;
    expect(content).toContain("src/server.ts lines 1-200");
    expect(content).toContain("mocked summary");
    // manifest appears before summary
    expect(content.indexOf("src/server.ts")).toBeLessThan(content.indexOf("mocked summary"));
  });

  it("manifest stats surfaced in CompactionResult", async () => {
    const readTurns = makeReadFileTurns([{ path: "src/foo.ts", startLine: 1, endLine: 50 }]);
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...readTurns,
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
    expect(result.manifestStats?.entries).toBe(1);
    expect(result.manifestStats?.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase J.4 — Tiered summary prompts (buildSummarizationPrompt)
// ---------------------------------------------------------------------------

describe("Phase J.4 — Tiered summary prompts", () => {
  it("tier 1 (compactions 1-2) uses full task-shaped prompt (~1500 tokens)", () => {
    expect(buildSummarizationPrompt([], 1)).toContain("~1500 tokens");
    expect(buildSummarizationPrompt([], 2)).toContain("~1500 tokens");
  });

  it("tier 2 (compactions 3-4) uses structured bullet prompt with required headers", () => {
    const p3 = buildSummarizationPrompt([], 3);
    expect(p3).toContain("## Task");
    expect(p3).toContain("## Files touched");
    expect(p3).toContain("## Recent failures");
    expect(p3).toContain("## Open questions");
    expect(p3).toContain("~800 tokens");

    const p4 = buildSummarizationPrompt([], 4);
    expect(p4).toContain("## Task");
    expect(p4).toContain("~800 tokens");
  });

  it("tier 3 (compaction 5) uses minimal three-section prompt", () => {
    const p = buildSummarizationPrompt([], 5);
    expect(p).toContain("≤500 tokens");
    expect(p).toContain("## Last failure");
    expect(p).toContain("## Open question");
  });

  it("prompt length is monotonically shorter across tiers", () => {
    const t1 = buildSummarizationPrompt([], 1).length;
    const t2 = buildSummarizationPrompt([], 3).length;
    const t3 = buildSummarizationPrompt([], 5).length;
    expect(t2).toBeLessThan(t1);
    expect(t3).toBeLessThan(t2);
  });

  it("compactionDepth passed to summarize via SummarizerInput (integration)", async () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "cand" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const c = new ContextCompactor();
    await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
      client: stubClient,
    });
    // Verify summarize was called with compactionDepth: 1 (first compaction)
    expect(vi.mocked(summarize)).toHaveBeenCalledWith(
      expect.objectContaining({ compactionDepth: 1 })
    );
  });

  it("summaryTier surfaced in CompactionResult", async () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "cand" },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    // compaction count 0 → first compaction → nextCount 1 → tier 1
    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentUsage: 700_000,
      effectiveCap: 800_000,
      client: stubClient,
    });
    expect(result.summaryTier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T.1, T.2, T.4: E.3 per-iter file-read manifest (buildFileReadManifest)
// ---------------------------------------------------------------------------

describe("buildFileReadManifest — per-iter manifest (E.3)", () => {
  /** Build a responseInput that contains N read_file assistant+tool_result pairs. */
  function makeReadInput(
    reads: Array<{ callId: string; filePath: string; lineRange?: [number, number] }>
  ): ChatCompletionMessageParam[] {
    const msgs: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
    ];
    for (const { callId, filePath, lineRange } of reads) {
      const args: Record<string, unknown> = { filePath };
      if (lineRange) args["lineRange"] = lineRange;
      msgs.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify(args) },
          },
        ],
      } as ChatCompletionMessageParam);
      msgs.push({ role: "tool", tool_call_id: callId, content: "file content" } as ChatCompletionMessageParam);
    }
    // Add recency-guard messages so earlier reads become CANDIDATE
    msgs.push({ role: "assistant", content: "summary" });
    msgs.push({ role: "user", content: "next step" });
    msgs.push({ role: "assistant", content: "done" });
    return msgs;
  }

  it("T.1: manifest injected (entryCount > 0) when responseInput has read_file calls", () => {
    const responseInput = makeReadInput([
      { callId: "r1", filePath: "src/api/server.ts" },
    ]);
    const classified = classifyTurns(responseInput, []);
    const { manifest, entryCount } = buildFileReadManifest(responseInput, classified);
    expect(entryCount).toBeGreaterThan(0);
    // The manifest header should match the "## Files already read this run" injection format
    const injectedContent =
      `## Files already read this run\n${manifest}\n\n` +
      `Re-read ONLY if the file was modified since your last read.\n` +
      `Reference prior content by line number instead of re-reading.`;
    expect(injectedContent).toContain("## Files already read this run");
    expect(injectedContent).toContain("src/api/server.ts");
  });

  it("T.1b: structuredEntries expose totalReads, topFile, topCount for telemetry", () => {
    // Two reads of the same file (same range) — readCount should be 2.
    const responseInput = makeReadInput([
      { callId: "s1", filePath: "src/api/router.ts", lineRange: [1, 50] },
      { callId: "s2", filePath: "src/api/router.ts", lineRange: [1, 50] },
      { callId: "s3", filePath: "src/api/other.ts" },
    ]);
    const classified = classifyTurns(responseInput, []);
    const { entryCount, structuredEntries } = buildFileReadManifest(responseInput, classified);
    expect(entryCount).toBe(2); // 2 distinct files

    const totalReads = structuredEntries.reduce((s, e) => s + e.readCount, 0);
    expect(typeof totalReads).toBe("number");
    expect(totalReads).toBeGreaterThanOrEqual(entryCount); // totalReads >= entryCount always

    const topEntry = structuredEntries.reduce(
      (best, e) => (e.readCount > (best?.readCount ?? 0) ? e : best),
      structuredEntries[0],
    );
    expect(topEntry).toBeDefined();
    expect(topEntry.filePath).toBe("src/api/router.ts"); // most-read file
    expect(typeof topEntry.readCount).toBe("number");
    expect(topEntry.readCount).toBeGreaterThanOrEqual(1);
    expect(topEntry.lineRange).toBe("lines 1-50");
  });

  it("T.2: manifest NOT injected (entryCount === 0) when responseInput has no read_file calls", () => {
    const responseInput: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "apply_patch", arguments: JSON.stringify({ patch: "..." }) },
          },
        ],
      } as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "c1", content: "patched" } as ChatCompletionMessageParam,
      { role: "assistant", content: "done" },
    ];
    const classified = classifyTurns(responseInput, []);
    const { entryCount } = buildFileReadManifest(responseInput, classified);
    expect(entryCount).toBe(0);
  });

  it("T.4: buildFileReadManifest includes lineRange in entry when read had explicit range", () => {
    const responseInput = makeReadInput([
      { callId: "lr1", filePath: "src/api/server.ts", lineRange: [10, 50] },
    ]);
    const classified = classifyTurns(responseInput, []);
    const { manifest, entryCount } = buildFileReadManifest(responseInput, classified);
    expect(entryCount).toBe(1);
    expect(manifest).toContain("lines 10-50");
    expect(manifest).toContain("src/api/server.ts");
  });
});
