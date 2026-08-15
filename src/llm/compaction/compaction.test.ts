import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";
import { ContextCompactor, buildFileReadManifest, MANIFEST_MAX_ENTRIES } from "./ContextCompactor.js";
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
import { ManifestInjectionProcessor } from "../history/ManifestInjectionProcessor.js";
import type { ProcessorContext } from "../history/types.js";

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

// candidateTokens must be >= 4500 to pass the Compact.0.1 skip-guard:
// projectedSavings = candidateTokens - SUMMARY_OUTPUT_BUDGET(1500) >= MIN_MEANINGFUL_SAVINGS(3000)
// 20k chars / 4 = 5000 tok → 5000 - 1500 = 3500 >= 3000 ✓
const BIG_CANDIDATE = "x".repeat(20_000);

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
    { role: "assistant", content: BIG_CANDIDATE },  // candidate — must pass Compact.0.1 skip-guard
    { role: "assistant", content: BIG_CANDIDATE },  // candidate
    { role: "assistant", content: "a3" },
    { role: "assistant", content: "a4" },
    { role: "assistant", content: "a5" },
  ];
  for (let i = 0; i < n; i++) {
    await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
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
      currentContextTokens: 10_000,
      contextWindowLimit: 200_000,
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
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("no_candidates");
  });

  it("returns compacted and increments count when threshold met and candidates exist", async () => {
    const c = new ContextCompactor();
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
      client: stubClient,
    });
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(result.warning).toBeUndefined();
  });

  it("Compact.0: triggers when responseInput chars/4 >= contextWindow × threshold", async () => {
    const c = new ContextCompactor();
    // Large candidate so the skip-guard (Compact.0.1) also passes
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: BIG_CANDIDATE },  // candidate
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const size = Math.round(JSON.stringify(history).length / 4);
    // Set limit so size is just above 75%: limit = floor(size / 0.76)
    const contextWindowLimit = Math.floor(size / 0.76);
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: size,
      contextWindowLimit,
      client: stubClient,
    });
    expect(result.compacted).toBe(true);
  });

  it("emits warning string on 3rd compaction", async () => {
    const c = await compactorWithCount(2);
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "c3" },
      { role: "assistant", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
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
        currentContextTokens: 160_000,
        contextWindowLimit: 200_000,
        client: stubClient,
      });
    }).rejects.toThrow(CompactionExhaustedError);
  });

  // Compact.0.1: candidate-mass skip-guard tests
  it("Compact.0.1: returns insufficient_candidate_mass when projected savings too small", async () => {
    const c = new ContextCompactor();
    // One tiny candidate (falls outside recency window of last 3) — too small to save after
    // SUMMARY_OUTPUT_BUDGET=1500 tok headroom; trigger fires but skip-guard returns early.
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "tiny-candidate" },  // CANDIDATE — small → skip-guard fires
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const size = Math.round(JSON.stringify(history).length / 4);
    // Put context at 80% full so threshold fires
    const contextWindowLimit = Math.floor(size / 0.81);
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: size,
      contextWindowLimit,
      client: stubClient,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("insufficient_candidate_mass");
  });

  it("Compact.0.1: compactionCount NOT bumped on skip", async () => {
    const c = new ContextCompactor();
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const size = Math.round(JSON.stringify(history).length / 4);
    const contextWindowLimit = Math.floor(size / 0.81);
    await c.checkAndMaybeCompact({ responseInput: history, toolCallLog: [], currentContextTokens: size, contextWindowLimit, client: stubClient });
    await c.checkAndMaybeCompact({ responseInput: history, toolCallLog: [], currentContextTokens: size, contextWindowLimit, client: stubClient });
    expect(c.getCompactionCount()).toBe(0);
  });

  it("Compact.0.1: summarize spy NOT called on skip", async () => {
    const c = new ContextCompactor();
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const size = Math.round(JSON.stringify(history).length / 4);
    const contextWindowLimit = Math.floor(size / 0.81);
    await c.checkAndMaybeCompact({ responseInput: history, toolCallLog: [], currentContextTokens: size, contextWindowLimit, client: stubClient });
    expect(vi.mocked(summarize)).not.toHaveBeenCalled();
  });

  it("Compact.0.1: real-mass candidates still compact normally", async () => {
    const c = new ContextCompactor();
    // Pad candidate messages so candidateTokens > SUMMARY_OUTPUT_BUDGET(1500) + MIN_MEANINGFUL_SAVINGS(3000).
    // Need >4500 tok = >18000 chars of candidate content.
    const bigContent = "x".repeat(20000);
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: bigContent },  // candidate
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const size = Math.round(JSON.stringify(history).length / 4);
    const contextWindowLimit = Math.floor(size / 0.81);
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: size,
      contextWindowLimit,
      client: stubClient,
    });
    expect(result.compacted).toBe(true);
  });

  it("Compact.0.1: overflow warning fires exactly once across repeated skips", async () => {
    const c = new ContextCompactor();
    // One tiny candidate so skip-guard fires; context at or above limit so overflow triggers.
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "tiny-candidate" },  // CANDIDATE — small → skip-guard fires
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const size = Math.round(JSON.stringify(history).length / 4);
    // currentContextTokens >= contextWindowLimit triggers the overflow-warning branch
    const contextWindowLimit = size - 1;
    const onOverflowWarning = vi.fn();
    for (let i = 0; i < 3; i++) {
      await c.checkAndMaybeCompact({
        responseInput: history,
        toolCallLog: [],
        currentContextTokens: size,
        contextWindowLimit,
        client: stubClient,
        onOverflowWarning,
      });
    }
    expect(onOverflowWarning).toHaveBeenCalledTimes(1);
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
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "recency-3" },
      { role: "user", content: "recency-2" },
      { role: "assistant", content: "recency-1" },
    ];

    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
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
    // Third: synthetic turn with compacted_history wrapper. role:"user", not
    // "system" — a mid-array system message is hoisted into the top-level system
    // prompt by extractSystem, rewriting cache breakpoint #1 as originally reasoned
    // (item 161: breakpoint #1 is tools-only; see ContextCompactor.ts's own
    // correction for the fuller note — the more plausible risk is breakpoint #2).
    expect(nr[2].role).toBe("user");
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
      currentContextTokens: 10_000,
      contextWindowLimit: 200_000,
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
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
    });
    expect(c.getCompactionCount()).toBe(0);

    // real compaction — should increment
    const withCandidates: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    await c.checkAndMaybeCompact({
      responseInput: withCandidates,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
      client: stubClient,
    });
    expect(c.getCompactionCount()).toBe(1);
  });

  it("recurring notice absent in synthetic turn for 1st and 2nd compaction", async () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    for (let pass = 1; pass <= 2; pass++) {
      const c = await compactorWithCount(pass - 1);
      const result = await c.checkAndMaybeCompact({
        responseInput: [...history],
        toolCallLog: [],
        currentContextTokens: 160_000,
        contextWindowLimit: 200_000,
        client: stubClient,
      });
      const syntheticTurn = result.newResponseInput?.find(
        (t) => t.role === "user" && typeof t.content === "string" && (t.content as string).includes("[compacted_history]")
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
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    for (let pass = 3; pass <= 5; pass++) {
      const c = await compactorWithCount(pass - 1);
      const result = await c.checkAndMaybeCompact({
        responseInput: [...history],
        toolCallLog: [],
        currentContextTokens: 160_000,
        contextWindowLimit: 200_000,
        client: stubClient,
      });
      const syntheticTurn = result.newResponseInput?.find(
        (t) => t.role === "user" && typeof t.content === "string" && (t.content as string).includes("[compacted_history]")
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
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];

    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
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
    expect(result.manifest).toContain("- src/foo.ts");
    expect(result.manifest).toContain("- src/bar.ts");
    expect(result.entryCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("dedupes same-file reads into single manifest entry", () => {
    const turns = makeReadFileTurns([
      { path: "src/foo.ts", startLine: 1, endLine: 100 },
      { path: "src/foo.ts", startLine: 1, endLine: 100 },
    ]);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    // read count tracked in structuredEntries (not in manifest text)
    expect(result.structuredEntries.find((e) => e.filePath === "src/foo.ts")?.readCount).toBe(2);
    const fileLines = result.manifest.split("\n").filter((l) => l.includes("src/foo.ts"));
    expect(fileLines).toHaveLength(1);  // one manifest line for the file
  });

  it("aggregates distinct ranges of the same file into one manifest entry", () => {
    const turns = makeReadFileTurns([
      { path: "src/foo.ts", startLine: 1, endLine: 100 },
      { path: "src/foo.ts", startLine: 200, endLine: 400 },
    ]);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    // both ranges tracked in structuredEntries dominant lineRange
    expect(result.structuredEntries.find((e) => e.filePath === "src/foo.ts")).toBeDefined();
    // manifest has exactly one entry for the file path
    const fileLines = result.manifest.split("\n").filter((l) => l.includes("src/foo.ts"));
    expect(fileLines).toHaveLength(1);
    expect(result.entryCount).toBe(1);  // one path entry, two ranges aggregated
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
    expect(result.entryCount).toBe(MANIFEST_MAX_ENTRIES);
    // truncation footer removed from manifest text (Plan B stable formatter)
    expect(result.manifest).not.toContain("truncated");
    expect(result.manifest).not.toContain("more entries");
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
      { role: "assistant", content: BIG_CANDIDATE },  // ensure skip-guard passes
      ...readTurns,                          // CANDIDATE read_file pair
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
      client: stubClient,
    });
    expect(result.compacted).toBe(true);
    const synth = result.newResponseInput?.find(
      (t) => t.role === "user" && typeof t.content === "string" && (t.content as string).includes("[compacted_history]")
    );
    expect(synth).toBeDefined();
    const content = synth!.content as string;
    expect(content).toContain("- src/server.ts");
    expect(content).toContain("mocked summary");
    // manifest appears before summary
    expect(content.indexOf("src/server.ts")).toBeLessThan(content.indexOf("mocked summary"));
  });

  it("manifest stats surfaced in CompactionResult", async () => {
    const readTurns = makeReadFileTurns([{ path: "src/foo.ts", startLine: 1, endLine: 50 }]);
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: BIG_CANDIDATE },  // ensure skip-guard passes
      ...readTurns,
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
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
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    const c = new ContextCompactor();
    await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
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
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "last-3" },
      { role: "user", content: "last-2" },
      { role: "assistant", content: "last-1" },
    ];
    // compaction count 0 → first compaction → nextCount 1 → tier 1
    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
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
      `Reference prior content by line number instead of re-reading.\n` +
      `(Automated cache notice from the system — NOT a new user request. Continue the task above; if it is already complete, write the FINAL SUMMARY.)`;
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

  it("T.4: buildFileReadManifest includes lineRange in structuredEntries when read had explicit range", () => {
    const responseInput = makeReadInput([
      { callId: "lr1", filePath: "src/api/server.ts", lineRange: [10, 50] },
    ]);
    const classified = classifyTurns(responseInput, []);
    const { manifest, entryCount, structuredEntries } = buildFileReadManifest(responseInput, classified);
    expect(entryCount).toBe(1);
    // lineRange in structuredEntries (not in manifest text — Plan B stable formatter)
    expect(structuredEntries.find((e) => e.filePath === "src/api/server.ts")?.lineRange).toContain("10-50");
    expect(manifest).toContain("src/api/server.ts");
  });
});

// ---------------------------------------------------------------------------
// Plan B — buildFileReadManifest stable formatter (cache breakpoint #2)
// ---------------------------------------------------------------------------

describe("buildFileReadManifest — Plan B stable formatter (cache breakpoint #2)", () => {
  it("manifest text is byte-identical when same file is re-read with different ranges", () => {
    const turns1 = makeReadFileTurns([
      { path: "src/foo.ts", startLine: 1, endLine: 100 },
    ]);
    const turns5 = makeReadFileTurns([
      { path: "src/foo.ts", startLine: 1, endLine: 50 },
      { path: "src/foo.ts", startLine: 51, endLine: 100 },
      { path: "src/foo.ts", startLine: 200, endLine: 300 },
      { path: "src/foo.ts", startLine: 400, endLine: 500 },
      { path: "src/foo.ts", startLine: 700, endLine: 800 },
    ]);
    const r1 = buildFileReadManifest(turns1, allCandidateClassifications(turns1));
    const r5 = buildFileReadManifest(turns5, allCandidateClassifications(turns5));
    expect(r1.manifest).toBe(r5.manifest);
    expect(r5.structuredEntries[0]?.readCount).toBe(5);
  });

  it("manifest changes only when a genuinely new file path is added", () => {
    const tFoo = makeReadFileTurns([{ path: "src/foo.ts", startLine: 1, endLine: 100 }]);
    const tFooBar = makeReadFileTurns([
      { path: "src/foo.ts", startLine: 1, endLine: 100 },
      { path: "src/bar.ts", startLine: 1, endLine: 50 },
    ]);
    const rFoo = buildFileReadManifest(tFoo, allCandidateClassifications(tFoo));
    const rFooBar = buildFileReadManifest(tFooBar, allCandidateClassifications(tFooBar));
    expect(rFoo.manifest).not.toBe(rFooBar.manifest);
    // alphabetical order — bar before foo
    expect(rFooBar.manifest.indexOf("src/bar.ts")).toBeLessThan(
      rFooBar.manifest.indexOf("src/foo.ts")
    );
  });

  it("no truncation footer in manifest text — truncated flag still set", () => {
    const reads = Array.from({ length: MANIFEST_MAX_ENTRIES + 5 }, (_, i) => ({
      path: `src/file${String(i).padStart(2, "0")}.ts`,
      startLine: 1,
      endLine: 10,
    }));
    const turns = makeReadFileTurns(reads);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(result.manifest).not.toContain("truncated");
    expect(result.manifest).not.toContain("more entries");
    expect(result.truncated).toBe(true);
    expect(result.entryCount).toBe(MANIFEST_MAX_ENTRIES);
  });

  it("manifest entries are sorted alphabetically", () => {
    const turns = makeReadFileTurns([
      { path: "src/z_last.ts", startLine: 1, endLine: 10 },
      { path: "src/a_first.ts", startLine: 1, endLine: 10 },
      { path: "src/m_middle.ts", startLine: 1, endLine: 10 },
    ]);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    const lines = result.manifest.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("a_first");
    expect(lines[1]).toContain("m_middle");
    expect(lines[2]).toContain("z_last");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.A — LRU eviction cap (MANIFEST_MAX_ENTRIES = 8)
// ---------------------------------------------------------------------------

describe("buildFileReadManifest — LRU eviction cap (Phase 6.A)", () => {
  it("T.cap-stable: exactly MANIFEST_MAX_ENTRIES files — capped:false, all present", () => {
    const reads = Array.from({ length: MANIFEST_MAX_ENTRIES }, (_, i) => ({
      path: `src/file${i}.ts`,
      startLine: 1,
      endLine: 10,
    }));
    const turns = makeReadFileTurns(reads);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(result.capped).toBe(false);
    expect(result.entryCount).toBe(MANIFEST_MAX_ENTRIES);
    for (let i = 0; i < MANIFEST_MAX_ENTRIES; i++) {
      expect(result.manifest).toContain(`src/file${i}.ts`);
    }
  });

  it("T.eviction: oldest-read file evicted when MANIFEST_MAX_ENTRIES+1 files read", () => {
    // a-oldest.ts is read first; 8 newer files follow — a-oldest.ts must be evicted
    const reads = [
      { path: "src/a-oldest.ts", startLine: 1, endLine: 10 },
      ...Array.from({ length: MANIFEST_MAX_ENTRIES }, (_, i) => ({
        path: `src/b-newer-${i}.ts`,
        startLine: 1,
        endLine: 10,
      })),
    ];
    const turns = makeReadFileTurns(reads);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(result.capped).toBe(true);
    expect(result.entryCount).toBe(MANIFEST_MAX_ENTRIES);
    expect(result.manifest).not.toContain("a-oldest.ts");
    for (let i = 0; i < MANIFEST_MAX_ENTRIES; i++) {
      expect(result.manifest).toContain(`b-newer-${i}.ts`);
    }
  });

  it("T.freshness: re-reading an existing file does not grow the set past cap", () => {
    const reads = [
      ...Array.from({ length: MANIFEST_MAX_ENTRIES }, (_, i) => ({
        path: `src/file${i}.ts`,
        startLine: 1,
        endLine: 10,
      })),
      // re-read file0 with a different range — still only MANIFEST_MAX_ENTRIES unique files
      { path: "src/file0.ts", startLine: 50, endLine: 100 },
    ];
    const turns = makeReadFileTurns(reads);
    const result = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(result.capped).toBe(false);
    expect(result.entryCount).toBe(MANIFEST_MAX_ENTRIES);
    expect(result.manifest).toContain("src/file0.ts");
  });

  it("T.bytes: same input produces byte-identical manifest on repeated calls", () => {
    const reads = Array.from({ length: MANIFEST_MAX_ENTRIES }, (_, i) => ({
      path: `src/stable${i}.ts`,
      startLine: 1,
      endLine: 10,
    }));
    const turns = makeReadFileTurns(reads);
    const r1 = buildFileReadManifest(turns, allCandidateClassifications(turns));
    const r2 = buildFileReadManifest(turns, allCandidateClassifications(turns));
    expect(r1.manifest).toBe(r2.manifest);
    expect(r1.capped).toBe(r2.capped);
  });
});

// ---------------------------------------------------------------------------
// Phase 6.A — ManifestInjectionProcessor [zone-manifest-set-growth] telemetry
// ---------------------------------------------------------------------------

describe("ManifestInjectionProcessor — [zone-manifest-set-growth] telemetry (Phase 6.A)", () => {
  function makeCtx(emitFn: ProcessorContext["emit"]): ProcessorContext {
    return { iter: 0, runId: "test-run", toolCallLog: [], pollingState: new Map(), emit: emitFn };
  }

  function makeProc() {
    return new ManifestInjectionProcessor({ kind: "manifest_injection" });
  }

  function growthCalls(emitMock: ReturnType<typeof vi.fn>) {
    return emitMock.mock.calls.filter((c) => c[1] === "[zone-manifest-set-growth]");
  }

  // classifyTurns marks turns as CANDIDATE only when there are recency-guard
  // messages after the reads. Wrap bare read turns with system/user header and
  // trailing assistant/user/assistant so classifyTurns sees them as older reads.
  function withGuards(inner: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    return [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...inner,
      { role: "assistant", content: "summary" },
      { role: "user", content: "next step" },
      { role: "assistant", content: "done" },
    ];
  }

  it("T.first-call: no [zone-manifest-set-growth] emission on first iteration", () => {
    const emit = vi.fn();
    const proc = makeProc();
    const turns = withGuards(makeReadFileTurns([{ path: "src/a.ts", startLine: 1, endLine: 10 }]));
    proc.process(turns, makeCtx(emit));
    expect(growthCalls(emit)).toHaveLength(0);
  });

  it("T.same-set: no emission when second call sees identical file set", () => {
    const emit = vi.fn();
    const proc = makeProc();
    const turns = withGuards(makeReadFileTurns([{ path: "src/a.ts", startLine: 1, endLine: 10 }]));
    proc.process(turns, makeCtx(emit));
    emit.mockClear();
    proc.process(turns, makeCtx(emit));
    expect(growthCalls(emit)).toHaveLength(0);
  });

  it("T.add-file: emits with addedFiles when a new file joins within cap", () => {
    const emit = vi.fn();
    const proc = makeProc();
    const turns1 = withGuards(makeReadFileTurns([
      { path: "src/a.ts", startLine: 1, endLine: 10 },
      { path: "src/b.ts", startLine: 1, endLine: 10 },
    ]));
    proc.process(turns1, makeCtx(emit));
    emit.mockClear();
    const turns2 = withGuards(makeReadFileTurns([
      { path: "src/a.ts", startLine: 1, endLine: 10 },
      { path: "src/b.ts", startLine: 1, endLine: 10 },
      { path: "src/c.ts", startLine: 1, endLine: 10 },
    ]));
    proc.process(turns2, makeCtx(emit));
    const calls = growthCalls(emit);
    expect(calls).toHaveLength(1);
    const payload = calls[0][2] as { addedFiles: string[]; droppedFiles: string[]; cappedAtMax: boolean };
    expect(payload.addedFiles).toContain("src/c.ts");
    expect(payload.droppedFiles).toHaveLength(0);
    expect(payload.cappedAtMax).toBe(false);
  });

  it("T.at-cap: emits with droppedFiles + cappedAtMax:true when cap evicts oldest", () => {
    const emit = vi.fn();
    const proc = makeProc();
    // Establish MANIFEST_MAX_ENTRIES files — oldest is a-oldest.ts (read first)
    const reads8 = [
      { path: "src/a-oldest.ts", startLine: 1, endLine: 10 },
      ...Array.from({ length: MANIFEST_MAX_ENTRIES - 1 }, (_, i) => ({
        path: `src/z-file${i}.ts`,
        startLine: 1,
        endLine: 10,
      })),
    ];
    proc.process(withGuards(makeReadFileTurns(reads8)), makeCtx(emit));
    emit.mockClear();
    // Second call: same 8 files PLUS one new file — cap fires, a-oldest.ts evicted
    const reads9 = [
      { path: "src/a-oldest.ts", startLine: 1, endLine: 10 },
      ...Array.from({ length: MANIFEST_MAX_ENTRIES - 1 }, (_, i) => ({
        path: `src/z-file${i}.ts`,
        startLine: 1,
        endLine: 10,
      })),
      { path: "src/new.ts", startLine: 1, endLine: 10 },
    ];
    proc.process(withGuards(makeReadFileTurns(reads9)), makeCtx(emit));
    const calls = growthCalls(emit);
    expect(calls).toHaveLength(1);
    const payload = calls[0][2] as { addedFiles: string[]; droppedFiles: string[]; cappedAtMax: boolean };
    expect(payload.addedFiles).toContain("src/new.ts");
    expect(payload.droppedFiles).toContain("src/a-oldest.ts");
    expect(payload.cappedAtMax).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compact.1 + Compact.2 — event typing + token delta
// ---------------------------------------------------------------------------

describe("Compact.1 — compaction event types in ZoneStructuredProgressEvent union", () => {
  it("compaction_status, compaction_exhausted, compaction_started are valid type literals", () => {
    // These assignments would be TypeScript compile errors if the types were absent.
    const _s: ZoneStructuredProgressEvent["type"] = "compaction_status";
    const _e: ZoneStructuredProgressEvent["type"] = "compaction_exhausted";
    const _b: ZoneStructuredProgressEvent["type"] = "compaction_started";
    expect(_s).toBe("compaction_status");
    expect(_e).toBe("compaction_exhausted");
    expect(_b).toBe("compaction_started");
  });
});

describe("Compact.2 — CompactionResult token delta", () => {
  const history: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    { role: "assistant", content: BIG_CANDIDATE },
    { role: "assistant", content: "last-3" },
    { role: "user", content: "last-2" },
    { role: "assistant", content: "last-1" },
  ];

  it("tokensBefore/tokensAfter/savedTokens present and satisfy the delta formula when compacted", async () => {
    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
      client: stubClient,
    });
    expect(result.compacted).toBe(true);
    expect(typeof result.tokensBefore).toBe("number");
    expect(typeof result.tokensAfter).toBe("number");
    expect(typeof result.savedTokens).toBe("number");
    expect(result.tokensBefore!).toBeGreaterThan(0);
    expect(result.tokensAfter!).toBeGreaterThan(0);
    expect(result.savedTokens).toBe(Math.max(0, result.tokensBefore! - result.tokensAfter!));
  });

  it("token fields absent when compaction does not fire (under_threshold)", async () => {
    const c = new ContextCompactor();
    const result = await c.checkAndMaybeCompact({
      responseInput: [],
      toolCallLog: [],
      currentContextTokens: 10_000,
      contextWindowLimit: 200_000,
    });
    expect(result.compacted).toBe(false);
    expect(result.tokensBefore).toBeUndefined();
    expect(result.tokensAfter).toBeUndefined();
    expect(result.savedTokens).toBeUndefined();
  });
});

describe("Compact.3-A — onCompactionStarted callback", () => {
  it("fires with the compaction count before summarize is called", async () => {
    const c = new ContextCompactor();
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "a3" },
      { role: "assistant", content: "a4" },
      { role: "assistant", content: "a5" },
    ];
    const calls: number[] = [];
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 160_000,
      contextWindowLimit: 200_000,
      client: stubClient,
      onCompactionStarted: (count) => { calls.push(count); },
    });
    expect(result.compacted).toBe(true);
    expect(calls).toEqual([1]);
  });
});

describe("Compact.3-C — ZONE_COMPACTION_TEST_RATIO threshold override", () => {
  it("triggers compaction at 60% usage when override is 0.5", async () => {
    vi.stubEnv("ZONE_COMPACTION_TEST_RATIO", "0.5");
    const c = new ContextCompactor();
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: BIG_CANDIDATE },
      { role: "assistant", content: "a3" },
      { role: "assistant", content: "a4" },
      { role: "assistant", content: "a5" },
    ];
    // 60% of cap — below 0.75 default, above 0.5 override → should compact
    const result = await c.checkAndMaybeCompact({
      responseInput: history,
      toolCallLog: [],
      currentContextTokens: 120_000,
      contextWindowLimit: 200_000,
      client: stubClient,
    });
    vi.unstubAllEnvs();
    expect(result.compacted).toBe(true);
  });

  it("invalid value falls back to 0.75 — no silent compaction disable", async () => {
    vi.stubEnv("ZONE_COMPACTION_TEST_RATIO", "foo");
    const c = new ContextCompactor();
    // 60% of cap — under 0.75 fallback threshold
    const result = await c.checkAndMaybeCompact({
      responseInput: [],
      toolCallLog: [],
      currentContextTokens: 120_000,
      contextWindowLimit: 200_000,
    });
    vi.unstubAllEnvs();
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("under_threshold");
  });
});
