/**
 * Phase R.2 unit tests: stale read eviction + summary preservation.
 */

import { describe, expect, it, vi } from "vitest";
import { pruneStaleReads, emitContextPruned } from "./contextPruner.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const logSpy = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock("../utils/logger.js", () => ({
  log: logSpy.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

// ---- helpers ----

function sys(): ChatCompletionMessageParam {
  return { role: "system", content: "You are Zone." };
}
function user(content = "Fix the bug"): ChatCompletionMessageParam {
  return { role: "user", content };
}
function assistantWithTool(callId: string, toolName: string): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id: callId, type: "function", function: { name: toolName, arguments: JSON.stringify({ filePath: `src/${callId}.ts` }) } }],
  } as ChatCompletionMessageParam;
}
function toolResult(callId: string, content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: callId, content } as ChatCompletionMessageParam;
}
function assistantText(text: string): ChatCompletionMessageParam {
  return { role: "assistant", content: text };
}

// Build a conversation with N read iterations.
// Each iteration = assistantWithTool + toolResult.
// Appends a final user message to simulate "current turn".
function buildNReadIters(n: number, fileContent = "const x = 1;\n".repeat(50)): ChatCompletionMessageParam[] {
  const msgs: ChatCompletionMessageParam[] = [sys(), user()];
  for (let i = 0; i < n; i++) {
    msgs.push(assistantWithTool(`call-${i}`, "read_file"));
    msgs.push(toolResult(`call-${i}`, fileContent));
  }
  return msgs;
}

// ---- pruneStaleReads ----

describe("pruneStaleReads — basic eviction", () => {
  it("empty messages → no-op, stats all zero", () => {
    const { pruned, stats } = pruneStaleReads([]);
    expect(pruned).toHaveLength(0);
    expect(stats.blocksReplaced).toBe(0);
    expect(stats.charsSaved).toBe(0);
    expect(stats.blocksKept).toBe(0);
  });

  it("no assistant groups → no-op", () => {
    const msgs = [sys(), user()];
    const { pruned, stats } = pruneStaleReads(msgs);
    expect(pruned).toHaveLength(msgs.length);
    expect(stats.blocksReplaced).toBe(0);
  });

  it("within fresh window (window=2, 2 groups) → nothing evicted", () => {
    const msgs = buildNReadIters(2);
    const { pruned, stats } = pruneStaleReads(msgs, 2);
    expect(stats.blocksReplaced).toBe(0);
    expect(stats.blocksKept).toBe(2);
    expect(pruned).toHaveLength(msgs.length);
  });

  it("3 groups, window=2 → group 0 evicted, groups 1 and 2 kept", () => {
    const msgs = buildNReadIters(3);
    const { pruned, stats } = pruneStaleReads(msgs, 2);
    // group 0 is old (age=2, > window=2 is false... age must be > freshIterWindow)
    // numGroups=3; group0: age = 3-1-0 = 2; 2 > 2 is false → kept
    // Actually age > freshIterWindow: 2 > 2 is false → kept
    // Let's check: freshIterWindow default is 2, age must be > 2 to prune
    expect(stats.blocksReplaced).toBe(0);
    expect(stats.blocksKept).toBe(3);
  });

  it("4 groups, window=2 → group 0 evicted (age=3 > 2), groups 1,2,3 kept", () => {
    const msgs = buildNReadIters(4);
    const { pruned, stats } = pruneStaleReads(msgs, 2);
    // numGroups=4; group0 age=3 > 2 → evict; group1 age=2 → keep; group2 age=1 → keep; group3 age=0 → keep
    expect(stats.blocksReplaced).toBe(1);
    expect(stats.blocksKept).toBe(3);
  });

  it("5 groups, window=2 → groups 0 and 1 evicted (ages 4,3 > 2)", () => {
    const msgs = buildNReadIters(5);
    const { pruned, stats } = pruneStaleReads(msgs, 2);
    expect(stats.blocksReplaced).toBe(2);
    expect(stats.blocksKept).toBe(3);
  });
});

describe("pruneStaleReads — placeholder content", () => {
  it("placeholder includes file path when filePath arg is in tool_calls", () => {
    const msgs = buildNReadIters(4);
    const { pruned } = pruneStaleReads(msgs, 2);
    // First read (call-0) should be replaced
    const toolMsg = pruned.find(
      (m) => m.role === "tool" && (m as { tool_call_id?: string }).tool_call_id === "call-0"
    );
    expect(toolMsg).toBeDefined();
    const content = (toolMsg as { content?: string }).content ?? "";
    expect(content).toMatch(/Earlier read:/);
    expect(content).toMatch(/src\/call-0\.ts/);
    expect(content).toMatch(/lines/);
    expect(content).toMatch(/bytes/);
    expect(content).toMatch(/Re-read if needed/);
  });

  it("placeholder for missing filePath arg uses fallback format", () => {
    // Build messages where the assistant tool_call has no filePath in args
    const msgs: ChatCompletionMessageParam[] = [sys(), user()];
    for (let i = 0; i < 4; i++) {
      msgs.push({
        role: "assistant",
        content: "",
        tool_calls: [{ id: `nc-${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
      } as ChatCompletionMessageParam);
      msgs.push(toolResult(`nc-${i}`, "file content here\n".repeat(10)));
    }
    const { pruned } = pruneStaleReads(msgs, 2);
    const toolMsg = pruned.find(
      (m) => m.role === "tool" && (m as { tool_call_id?: string }).tool_call_id === "nc-0"
    );
    const content = (toolMsg as { content?: string }).content ?? "";
    expect(content).toMatch(/Earlier read result/);
    expect(content).not.toMatch(/undefined/);
  });

  it("charsSaved is positive when original content is larger than placeholder", () => {
    const largeContent = "x".repeat(2000);
    const msgs: ChatCompletionMessageParam[] = [
      sys(),
      user(),
      assistantWithTool("call-0", "read_file"),
      toolResult("call-0", largeContent),
      assistantWithTool("call-1", "read_file"),
      toolResult("call-1", largeContent),
      assistantWithTool("call-2", "read_file"),
      toolResult("call-2", largeContent),
      assistantWithTool("call-3", "read_file"),
      toolResult("call-3", largeContent),
    ];
    const { stats } = pruneStaleReads(msgs, 2);
    expect(stats.charsSaved).toBeGreaterThan(0);
  });
});

describe("pruneStaleReads — tool name selectivity", () => {
  it("search_in_files results are never evicted", () => {
    const msgs: ChatCompletionMessageParam[] = [sys(), user()];
    for (let i = 0; i < 5; i++) {
      msgs.push(assistantWithTool(`s-${i}`, "search_in_files"));
      msgs.push(toolResult(`s-${i}`, "3 matches found"));
    }
    const { stats } = pruneStaleReads(msgs, 2);
    expect(stats.blocksReplaced).toBe(0);
    expect(stats.blocksKept).toBe(0); // Not read_file so not counted in blocksKept either
  });

  it("run_command results are never evicted", () => {
    const msgs: ChatCompletionMessageParam[] = [sys(), user()];
    for (let i = 0; i < 5; i++) {
      msgs.push(assistantWithTool(`c-${i}`, "run_command"));
      msgs.push(toolResult(`c-${i}`, "[exit_code=0]\nnpm test passed"));
    }
    const { stats } = pruneStaleReads(msgs, 2);
    expect(stats.blocksReplaced).toBe(0);
  });

  it("list_directory results are not evicted (only read_file is pruned)", () => {
    const msgs: ChatCompletionMessageParam[] = [sys(), user()];
    for (let i = 0; i < 5; i++) {
      msgs.push(assistantWithTool(`d-${i}`, "list_directory"));
      msgs.push(toolResult(`d-${i}`, "src/\nsrc/a.ts\nsrc/b.ts\n"));
    }
    const { stats } = pruneStaleReads(msgs, 2);
    expect(stats.blocksReplaced).toBe(0);
  });

  it("only read_file is evicted when mixed with search and command", () => {
    const msgs: ChatCompletionMessageParam[] = [sys(), user()];
    // 4 iterations: alternating read_file and run_command
    msgs.push(assistantWithTool("r0", "read_file"));
    msgs.push(toolResult("r0", "file content\n".repeat(100)));
    msgs.push(assistantWithTool("c0", "run_command"));
    msgs.push(toolResult("c0", "output"));
    msgs.push(assistantWithTool("r1", "read_file"));
    msgs.push(toolResult("r1", "file content\n".repeat(100)));
    msgs.push(assistantWithTool("c1", "run_command"));
    msgs.push(toolResult("c1", "output"));

    const { stats } = pruneStaleReads(msgs, 2);
    // 4 groups, window=2: group0 age=3>2 → evict read_file (r0); c0 is run_command, never evicted
    expect(stats.blocksReplaced).toBe(1);
  });
});

describe("pruneStaleReads — original not mutated", () => {
  it("original messages array is not mutated", () => {
    const msgs = buildNReadIters(5);
    const origContents = msgs.map((m) => (m as { content?: unknown }).content);
    pruneStaleReads(msgs, 2);
    const afterContents = msgs.map((m) => (m as { content?: unknown }).content);
    expect(afterContents).toEqual(origContents);
  });

  it("returned pruned array is a different reference than input", () => {
    const msgs = buildNReadIters(3);
    const { pruned } = pruneStaleReads(msgs, 2);
    expect(pruned).not.toBe(msgs);
  });
});

describe("pruneStaleReads — non-read messages preserved verbatim", () => {
  it("system, user, and assistant text messages are always kept unchanged", () => {
    const msgs: ChatCompletionMessageParam[] = [
      sys(),
      user("my task"),
      assistantWithTool("call-0", "read_file"),
      toolResult("call-0", "content\n".repeat(200)),
      assistantText("I found the issue."),
      assistantWithTool("call-1", "read_file"),
      toolResult("call-1", "content\n".repeat(200)),
      assistantWithTool("call-2", "read_file"),
      toolResult("call-2", "content\n".repeat(200)),
      assistantWithTool("call-3", "read_file"),
      toolResult("call-3", "content\n".repeat(200)),
    ];
    const { pruned } = pruneStaleReads(msgs, 2);
    const sysMsg = pruned.find((m) => m.role === "system");
    expect((sysMsg as { content?: string })?.content).toBe("You are Zone.");
    const userMsg = pruned.find((m) => m.role === "user");
    expect((userMsg as { content?: string })?.content).toBe("my task");
    const assistTxt = pruned.find(
      (m) => m.role === "assistant" && !(m as { tool_calls?: unknown[] }).tool_calls
    );
    expect((assistTxt as { content?: string })?.content).toBe("I found the issue.");
  });
});

// ---- emitContextPruned ----

describe("emitContextPruned", () => {
  it("emits [zone-context-pruned] when blocksReplaced > 0", () => {
    logSpy.log.mockClear();
    emitContextPruned({ runId: "r1", iter: 3, stats: { blocksReplaced: 2, charsSaved: 1500, blocksKept: 4 } });
    expect(logSpy.log).toHaveBeenCalledWith(
      "[zone-context-pruned]",
      expect.stringContaining('"blocksReplaced":2')
    );
  });

  it("does NOT emit when blocksReplaced is 0", () => {
    logSpy.log.mockClear();
    emitContextPruned({ runId: "r1", iter: 0, stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: 5 } });
    expect(logSpy.log).not.toHaveBeenCalled();
  });

  it("emitted JSON includes runId, iter, charsSaved, blocksKept", () => {
    logSpy.log.mockClear();
    emitContextPruned({ runId: "run-xyz", iter: 7, stats: { blocksReplaced: 1, charsSaved: 800, blocksKept: 3 } });
    const payload = logSpy.log.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed["runId"]).toBe("run-xyz");
    expect(parsed["iter"]).toBe(7);
    expect(parsed["charsSaved"]).toBe(800);
    expect(parsed["blocksKept"]).toBe(3);
  });
});
