/**
 * Phase R.1 unit tests: token breakdown categorization + aggregation.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  categorizeMessages,
  emitTokenBreakdown,
  emitBreakdownSummary,
  type BreakdownEvent,
} from "./tokenBreakdown.js";

// Spy on logger.log so tests can verify emissions without stdout noise
const logSpy = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock("../utils/logger.js", () => ({
  log: logSpy.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- helpers ----

function makeSystemMsg(content: string) {
  return { role: "system" as const, content };
}
function makeUserMsg(content: string) {
  return { role: "user" as const, content };
}
function makeAssistantMsg(content: string, toolCallId?: string, toolName?: string) {
  if (toolCallId && toolName) {
    return {
      role: "assistant" as const,
      content,
      tool_calls: [{ id: toolCallId, function: { name: toolName, arguments: "{}" } }],
    };
  }
  return { role: "assistant" as const, content };
}
function makeToolMsg(toolCallId: string, content: string) {
  return { role: "tool" as const, tool_call_id: toolCallId, content };
}

// ---- categorization ----

describe("categorizeMessages — system prompt buckets", () => {
  it("places plain system content in system_prompt", () => {
    const msgs = [makeSystemMsg("You are Zone."), makeUserMsg("Fix the bug")];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.system_prompt.chars).toBeGreaterThan(0);
    expect(buckets.user_task.chars).toBeGreaterThan(0);
  });

  it("extracts PLAN ANNOTATIONS from system content into plan_annotations bucket", () => {
    const systemContent = [
      "You are Zone.\n\n",
      "PLAN ANNOTATIONS — delegatable steps in this run:\n",
      "- Step 1 (worker): Rename across 5 files — files: a.ts, b.ts\n",
      "\nWhen you reach a delegatable step, prefer Task dispatch.\n\n",
      "CRITICAL PATCH RULES:\nFollow these.",
    ].join("");
    const msgs = [makeSystemMsg(systemContent), makeUserMsg("rename it")];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });

    expect(buckets.plan_annotations.chars).toBeGreaterThan(0);
    expect(buckets.plan_annotations.blockCount).toBe(1);
    // System prompt should NOT double-count the plan annotations chars
    expect(buckets.system_prompt.chars + buckets.plan_annotations.chars).toBeLessThanOrEqual(
      systemContent.length + 5 // small tolerance for remainder whitespace
    );
  });

  it("extracts RELATED FILES block into import_context bucket", () => {
    const systemContent = [
      "You are Zone.\n\n",
      "RELATED FILES (read-only context for planning — call read_file for full content):\n",
      "src/a.ts → imports b, c\n",
      "(End related files context)\n\n",
      "CRITICAL PATCH RULES: …",
    ].join("");
    const msgs = [makeSystemMsg(systemContent), makeUserMsg("fix it")];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });

    expect(buckets.import_context.chars).toBeGreaterThan(0);
    expect(buckets.system_prompt.chars).toBeGreaterThan(0);
  });

  it('matches the actual repo manifest format: "Repository scanned (446 files, structure hints loaded)"', () => {
    const systemContent = `You are Zone.\n\nRepository scanned (446 files, structure hints loaded).\n\nCRITICAL PATCH RULES: …`;
    const msgs = [makeSystemMsg(systemContent), makeUserMsg("task")];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.repo_manifest.chars).toBeGreaterThan(0);
  });

  it("handles system content with no special sections — all goes to system_prompt", () => {
    const msgs = [makeSystemMsg("Short system prompt."), makeUserMsg("go")];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.system_prompt.chars).toBeGreaterThan(0);
    expect(buckets.plan_annotations.chars).toBe(0);
    expect(buckets.import_context.chars).toBe(0);
    expect(buckets.repo_manifest.chars).toBe(0);
  });
});

describe("categorizeMessages — user message buckets", () => {
  it("first user message → user_task", () => {
    const msgs = [makeSystemMsg("sys"), makeUserMsg("Fix the login bug")];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.user_task.chars).toBe("Fix the login bug".length);
    expect(buckets.user_task.blockCount).toBe(1);
  });

  it("subsequent user messages → other (loop warnings etc.)", () => {
    const msgs = [
      makeSystemMsg("sys"),
      makeUserMsg("task"),
      makeUserMsg("Notice: you called read_file again"),
    ];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.user_task.blockCount).toBe(1);
    expect(buckets.other.blockCount).toBe(1);
  });

  it("compaction summary in user message → compaction_summary bucket", () => {
    const msgs = [
      makeSystemMsg("sys"),
      makeUserMsg("Context compacted: here is a summary of what happened"),
    ];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.compaction_summary.chars).toBeGreaterThan(0);
    expect(buckets.user_task.chars).toBe(0);
  });
});

describe("categorizeMessages — assistant message buckets", () => {
  it("assistant text with no tool_calls → assistant_reasoning", () => {
    const msgs = [
      makeSystemMsg("sys"),
      makeUserMsg("task"),
      makeAssistantMsg("I will read the file first."),
    ];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.assistant_reasoning.chars).toBeGreaterThan(0);
    expect(buckets.assistant_tool_use.chars).toBe(0);
  });

  it("assistant with tool_calls → assistant_tool_use gets the call metadata", () => {
    const msgs = [
      makeSystemMsg("sys"),
      makeUserMsg("task"),
      makeAssistantMsg("Reading now.", "call-1", "read_file"),
    ];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.assistant_tool_use.chars).toBeGreaterThan(0);
    expect(buckets.assistant_tool_use.blockCount).toBe(1);
  });
});

describe("categorizeMessages — tool result buckets", () => {
  it("read_file result → tool_result_read", () => {
    const msgs = [
      makeSystemMsg("sys"),
      makeUserMsg("task"),
      makeAssistantMsg("", "call-1", "read_file"),
      makeToolMsg("call-1", "const x = 1;\n"),
    ];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.tool_result_read.chars).toBeGreaterThan(0);
  });

  it("run_command result → tool_result_command", () => {
    const msgs = [
      makeSystemMsg("sys"),
      makeUserMsg("task"),
      makeAssistantMsg("", "call-2", "run_command"),
      makeToolMsg("call-2", "[exit_code=0 — command succeeded]\nnpm test output here"),
    ];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.tool_result_command.chars).toBeGreaterThan(0);
  });

  it("search_in_files result → tool_result_search", () => {
    const msgs = [
      makeSystemMsg("sys"),
      makeUserMsg("task"),
      makeAssistantMsg("", "call-3", "search_in_files"),
      makeToolMsg("call-3", "Found 3 matches in src/"),
    ];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.tool_result_search.chars).toBeGreaterThan(0);
  });

  it("content-heuristic: [exit_code= prefix → tool_result_command when callIndex missing", () => {
    // Simulate a tool message with no matching assistant message (edge case)
    const msgs = [
      makeSystemMsg("sys"),
      makeUserMsg("task"),
      makeToolMsg("missing-id", "[exit_code=1 — command failed]\nsome output"),
    ];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.tool_result_command.chars).toBeGreaterThan(0);
  });

  it("unknown tool name with non-matching content → tool_result_other + uncategorized warning", () => {
    const msgs = [
      makeSystemMsg("sys"),
      makeUserMsg("task"),
      makeAssistantMsg("", "call-9", "some_unknown_tool"),
      makeToolMsg("call-9", "arbitrary output here"),
    ];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    // Goes to tool_result_other because tool name is known but not in read/cmd/search sets
    expect(buckets.tool_result_other.chars).toBeGreaterThan(0);
  });
});

describe("categorizeMessages — tool_descriptions bucket", () => {
  it("tool definitions add up in tool_descriptions", () => {
    const tools = [
      { name: "read_file", description: "Read a file", parameters: { type: "object" } },
      { name: "apply_patch", description: "Apply a patch", parameters: { type: "object" } },
    ];
    const msgs = [makeSystemMsg("sys"), makeUserMsg("task")];
    const buckets = categorizeMessages(msgs, tools, { runId: "r1", iter: 0 });
    expect(buckets.tool_descriptions.chars).toBeGreaterThan(0);
    expect(buckets.tool_descriptions.blockCount).toBe(1);
  });

  it("undefined tools → tool_descriptions stays zero", () => {
    const msgs = [makeSystemMsg("sys"), makeUserMsg("task")];
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    expect(buckets.tool_descriptions.chars).toBe(0);
  });
});

describe("estTokens approximation", () => {
  it("estTokens is ceil(chars / 4)", () => {
    const msgs = [makeSystemMsg("1234"), makeUserMsg("go")]; // 4 chars system + 2 user
    const buckets = categorizeMessages(msgs, undefined, { runId: "r1", iter: 0 });
    // system_prompt: 4 chars → ceil(4/4) = 1
    expect(buckets.system_prompt.estTokens).toBe(Math.ceil(buckets.system_prompt.chars / 4));
    // user_task: 2 chars → ceil(2/4) = 1
    expect(buckets.user_task.estTokens).toBe(Math.ceil(buckets.user_task.chars / 4));
  });
});

// ---- emission ----

describe("emitTokenBreakdown", () => {
  it("calls log with [zone-token-breakdown] tag", () => {
    const msgs = [makeSystemMsg("sys"), makeUserMsg("task")];
    emitTokenBreakdown({ runId: "r1", iter: 0, messages: msgs, tools: undefined, model: "test-model" });
    expect(logSpy.log).toHaveBeenCalledWith(
      "[zone-token-breakdown]",
      expect.stringContaining('"event":"token_breakdown"')
    );
  });

  it("returned event includes totals and model", () => {
    const msgs = [makeSystemMsg("hello world"), makeUserMsg("fix it")];
    const ev = emitTokenBreakdown({ runId: "r2", iter: 3, messages: msgs, tools: undefined, model: "gpt-test" });
    expect(ev.runId).toBe("r2");
    expect(ev.iter).toBe(3);
    expect(ev.model).toBe("gpt-test");
    expect(ev.totals.chars).toBeGreaterThan(0);
    expect(ev.totals.estTokens).toBe(Math.ceil(ev.totals.chars / 4));
  });

  it("includes parentRunId and subagentId when provided", () => {
    const msgs = [makeSystemMsg("sys"), makeUserMsg("task")];
    const ev = emitTokenBreakdown({
      runId: "child",
      parentRunId: "parent",
      subagentId: "sub-1",
      iter: 0,
      messages: msgs,
      tools: undefined,
      model: "m",
    });
    expect(ev.parentRunId).toBe("parent");
    expect(ev.subagentId).toBe("sub-1");
  });
});

// ---- aggregation ----

describe("emitBreakdownSummary", () => {
  function fakeEvent(
    runId: string,
    iter: number,
    overrides: Partial<BreakdownEvent["buckets"]> = {}
  ): BreakdownEvent {
    const msgs = [makeSystemMsg("system content here"), makeUserMsg("user task here")];
    const ev = emitTokenBreakdown({ runId, iter, messages: msgs, tools: undefined, model: "m" });
    // Apply overrides for controlled aggregation testing
    for (const [key, val] of Object.entries(overrides)) {
      (ev.buckets as Record<string, unknown>)[key] = val;
    }
    return ev;
  }

  it("summary totalCalls equals number of events passed", () => {
    const events = [fakeEvent("r", 0), fakeEvent("r", 1), fakeEvent("r", 2)];
    const summary = emitBreakdownSummary({ runId: "r", events });
    expect(summary.totalCalls).toBe(3);
  });

  it("topThreeWasters has exactly 3 entries sorted by pctOfTotal desc", () => {
    const events = [fakeEvent("r", 0), fakeEvent("r", 1)];
    const summary = emitBreakdownSummary({ runId: "r", events });
    expect(summary.topThreeWasters).toHaveLength(3);
    expect(summary.topThreeWasters[0]!.pctOfTotal).toBeGreaterThanOrEqual(
      summary.topThreeWasters[1]!.pctOfTotal
    );
    expect(summary.topThreeWasters[1]!.pctOfTotal).toBeGreaterThanOrEqual(
      summary.topThreeWasters[2]!.pctOfTotal
    );
  });

  it("pctOfTotal across all buckets sums to approximately 100", () => {
    const events = [fakeEvent("r", 0), fakeEvent("r", 1), fakeEvent("r", 2)];
    const summary = emitBreakdownSummary({ runId: "r", events });
    const total = Object.values(summary.byBucket).reduce((acc, b) => acc + b.pctOfTotal, 0);
    // Allow a small floating-point rounding tolerance
    expect(total).toBeGreaterThanOrEqual(99);
    expect(total).toBeLessThanOrEqual(101);
  });

  it("callsAppearedIn reflects how many calls had non-zero chars for that bucket", () => {
    // All three calls have system_prompt content
    const events = [fakeEvent("r", 0), fakeEvent("r", 1), fakeEvent("r", 2)];
    const summary = emitBreakdownSummary({ runId: "r", events });
    // system_prompt should appear in all 3 calls
    expect(summary.byBucket.system_prompt.callsAppearedIn).toBe(3);
    // tool_result_read should appear in 0 calls (no tool calls in fakeEvent)
    expect(summary.byBucket.tool_result_read.callsAppearedIn).toBe(0);
  });

  it("emits [zone-token-breakdown-summary] log tag", () => {
    vi.clearAllMocks();
    const events = [fakeEvent("r", 0)];
    emitBreakdownSummary({ runId: "r", events });
    expect(logSpy.log).toHaveBeenCalledWith(
      "[zone-token-breakdown-summary]",
      expect.stringContaining('"event":"token_breakdown_summary"')
    );
  });

  it("produces empty summary (0 calls, 0 chars) when events array is empty", () => {
    const summary = emitBreakdownSummary({ runId: "r", events: [] });
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalChars).toBe(0);
    expect(summary.topThreeWasters[0]!.pctOfTotal).toBe(0);
  });
});
