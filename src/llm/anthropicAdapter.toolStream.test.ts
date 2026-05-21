/**
 * Phase F1 — tool-input streaming via AnthropicAdapter.
 *
 * Tests that:
 *  1. agentLoop passes onToolArgumentsDelta to createChatCompletion options
 *     when onToolInputStream is provided.
 *  2. onToolInputStream fires with correct shape for apply_patch / write_file.
 *  3. isFirstDelta is true only for the first delta of each blockId.
 *  4. Non-write tools (read_file, search_in_files) are filtered out.
 *  5. Multiple tool calls in one response each get their own blockId stream.
 *  6. When onToolInputStream is absent, no streaming callback is wired.
 *  7. [zone-tool-stream-summary] telemetry fires after a run with deltas.
 *  8. No telemetry when no deltas occurred.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => ({
  clearCommandCacheForRun: vi.fn(() => undefined),
  executeTool: mocks.executeTool,
  withStagingTempFlush: mocks.withStagingTempFlush,
}));

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, log: mocks.log };
});

import { runAgentLoop } from "./agentLoop.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function textResponse(content: string, model = "claude-sonnet-4-6") {
  return {
    id: "msg-test",
    model,
    choices: [{ index: 0, message: { role: "assistant", content, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

function toolCallResponse(
  name: string,
  args: Record<string, unknown>,
  id = "tc-abc",
  model = "claude-sonnet-4-6"
) {
  return {
    id: "msg-test",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  };
}

// A createChatCompletion mock that simulates streaming: fires onToolArgumentsDelta
// three times if the callback is present, then returns the full response.
function makeStreamingApplyPatchMock(
  toolCallId = "tc-stream-1",
  filePath = "src/utils/files.ts",
  model = "claude-sonnet-4-6"
) {
  return vi.fn(
    async (
      _params: unknown,
      options: { onToolArgumentsDelta?: (id: string, name: string, delta: string) => void } = {}
    ) => {
      const fullArgs = JSON.stringify({ filePath, patch: "--- FIND ---\nfoo\n--- REPLACE ---\nbar" });
      const chunks = [fullArgs.slice(0, 15), fullArgs.slice(15, 40), fullArgs.slice(40)];
      for (const chunk of chunks) {
        options.onToolArgumentsDelta?.(toolCallId, "apply_patch", chunk);
      }
      return toolCallResponse("apply_patch", { filePath, patch: "--- FIND ---\nfoo\n--- REPLACE ---\nbar" }, toolCallId, model);
    }
  );
}

// Standard setup for a two-turn run: first call does the tool, second call finishes.
function setupTwoTurnRun(firstCallMock: ReturnType<typeof vi.fn>) {
  mocks.createChatCompletion
    .mockImplementationOnce(firstCallMock)
    .mockResolvedValueOnce(textResponse("Done."));
  mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
  mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Phase F1 — agentLoop onToolInputStream wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes onToolArgumentsDelta in options when onToolInputStream is provided", async () => {
    const capturedOptions: Array<{ onToolArgumentsDelta?: unknown }> = [];
    mocks.createChatCompletion.mockImplementation(async (_params: unknown, options: unknown) => {
      capturedOptions.push(options as { onToolArgumentsDelta?: unknown });
      return textResponse("Done.");
    });
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    await runAgentLoop({
      task: "test",
      repoPath: "/tmp",
      runId: "run-f1-wire",
      onToolInputStream: vi.fn(),
    });

    expect(capturedOptions.length).toBeGreaterThanOrEqual(1);
    expect(typeof capturedOptions[0]!.onToolArgumentsDelta).toBe("function");
  });

  it("does NOT pass onToolArgumentsDelta when onToolInputStream is absent", async () => {
    const capturedOptions: Array<{ onToolArgumentsDelta?: unknown }> = [];
    mocks.createChatCompletion.mockImplementation(async (_params: unknown, options: unknown) => {
      capturedOptions.push(options as { onToolArgumentsDelta?: unknown });
      return textResponse("Done.");
    });
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    await runAgentLoop({ task: "test", repoPath: "/tmp" });

    expect(capturedOptions[0]!.onToolArgumentsDelta).toBeUndefined();
  });

  it("onToolInputStream fires with correct shape for apply_patch deltas", async () => {
    const streamEvents: Array<{ blockId: string; toolName: string; delta: string; isFirstDelta: boolean }> = [];
    const streamMock = makeStreamingApplyPatchMock("tc-ap-1", "src/utils/files.ts");
    setupTwoTurnRun(streamMock);

    await runAgentLoop({
      task: "add getFileSize to src/utils/files.ts",
      repoPath: "/tmp",
      runId: "run-f1-shape",
      onToolInputStream: (evt) => streamEvents.push(evt),
    });

    expect(streamEvents.length).toBe(3);
    expect(streamEvents[0]!.toolName).toBe("apply_patch");
    expect(streamEvents[0]!.blockId).toBe("tc-ap-1");
    expect(streamEvents[0]!.isFirstDelta).toBe(true);
    expect(streamEvents[1]!.isFirstDelta).toBe(false);
    expect(streamEvents[2]!.isFirstDelta).toBe(false);
    expect(streamEvents.every((e) => e.iter === 1)).toBe(true);
  });

  it("onToolInputStream fires for write_file as well", async () => {
    const streamEvents: Array<{ toolName: string }> = [];
    const writeMock = vi.fn(
      async (_params: unknown, options: { onToolArgumentsDelta?: (id: string, name: string, delta: string) => void } = {}) => {
        options.onToolArgumentsDelta?.("tc-wf-1", "write_file", '{"filePath":"src/new.ts","content":"x"}');
        return toolCallResponse("write_file", { filePath: "src/new.ts", content: "x" }, "tc-wf-1");
      }
    );
    setupTwoTurnRun(writeMock);

    await runAgentLoop({
      task: "create src/new.ts",
      repoPath: "/tmp",
      onToolInputStream: (evt) => streamEvents.push({ toolName: evt.toolName }),
    });

    expect(streamEvents.some((e) => e.toolName === "write_file")).toBe(true);
  });

  it("onToolInputStream does NOT fire for read_file deltas", async () => {
    const streamEvents: Array<{ toolName: string }> = [];
    const readMock = vi.fn(
      async (_params: unknown, options: { onToolArgumentsDelta?: (id: string, name: string, delta: string) => void } = {}) => {
        // Simulate delta coming from adapter for read_file
        options.onToolArgumentsDelta?.("tc-rf-1", "read_file", '{"filePath":"src/utils/files.ts"}');
        return toolCallResponse("read_file", { filePath: "src/utils/files.ts" }, "tc-rf-1");
      }
    );
    setupTwoTurnRun(readMock);

    await runAgentLoop({
      task: "read a file",
      repoPath: "/tmp",
      onToolInputStream: (evt) => streamEvents.push({ toolName: evt.toolName }),
    });

    expect(streamEvents.filter((e) => e.toolName === "read_file").length).toBe(0);
  });

  it("onToolInputStream does NOT fire for search_in_files deltas", async () => {
    const streamEvents: Array<{ toolName: string }> = [];
    const searchMock = vi.fn(
      async (_params: unknown, options: { onToolArgumentsDelta?: (id: string, name: string, delta: string) => void } = {}) => {
        options.onToolArgumentsDelta?.("tc-sf-1", "search_in_files", '{"pattern":"foo"}');
        return toolCallResponse("search_in_files", { pattern: "foo" }, "tc-sf-1");
      }
    );
    setupTwoTurnRun(searchMock);

    await runAgentLoop({
      task: "search for something",
      repoPath: "/tmp",
      onToolInputStream: (evt) => streamEvents.push({ toolName: evt.toolName }),
    });

    expect(streamEvents.filter((e) => e.toolName === "search_in_files").length).toBe(0);
  });

  it("two sequential apply_patch calls each start with isFirstDelta=true", async () => {
    const streamEvents: Array<{ blockId: string; isFirstDelta: boolean }> = [];
    const twoCallsMock = vi.fn(
      async (_params: unknown, options: { onToolArgumentsDelta?: (id: string, name: string, delta: string) => void } = {}) => {
        options.onToolArgumentsDelta?.("tc-a", "apply_patch", '{"filePath":"a.ts"}');
        options.onToolArgumentsDelta?.("tc-b", "apply_patch", '{"filePath":"b.ts"}');
        return {
          id: "msg-2",
          model: "claude-sonnet-4-6",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "tc-a", type: "function", function: { name: "apply_patch", arguments: '{"filePath":"a.ts","patch":""}' } },
                  { id: "tc-b", type: "function", function: { name: "apply_patch", arguments: '{"filePath":"b.ts","patch":""}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
        };
      }
    );
    mocks.createChatCompletion
      .mockImplementationOnce(twoCallsMock)
      .mockResolvedValueOnce(textResponse("All done."));
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    await runAgentLoop({
      task: "patch two files",
      repoPath: "/tmp",
      onToolInputStream: (evt) => streamEvents.push({ blockId: evt.blockId, isFirstDelta: evt.isFirstDelta }),
    });

    const blockA = streamEvents.filter((e) => e.blockId === "tc-a");
    const blockB = streamEvents.filter((e) => e.blockId === "tc-b");
    expect(blockA[0]!.isFirstDelta).toBe(true);
    expect(blockB[0]!.isFirstDelta).toBe(true);
  });
});

describe("Phase F1.4 — worker subagent tool input streaming", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("parent runs emit deltas with no subagentId (back-compat)", async () => {
    const streamEvents: Array<{ subagentId?: string | null }> = [];
    setupTwoTurnRun(makeStreamingApplyPatchMock("tc-parent-1", "src/p.ts"));

    await runAgentLoop({
      task: "parent patch",
      repoPath: "/tmp",
      runId: "run-parent",
      onToolInputStream: (evt) => streamEvents.push({ subagentId: evt.subagentId }),
      // No `subagent` field → parent context.
    });

    expect(streamEvents.length).toBe(3);
    for (const evt of streamEvents) {
      // null OR undefined (the property may not be set at all for parents).
      expect(evt.subagentId == null).toBe(true);
    }
  });

  it("worker runs tag every delta with subagentId from the subagent context", async () => {
    const streamEvents: Array<{ subagentId?: string | null; blockId: string }> = [];
    setupTwoTurnRun(makeStreamingApplyPatchMock("tc-worker-1", "src/w.ts"));

    await runAgentLoop({
      task: "worker patch",
      repoPath: "/tmp",
      runId: "run-parent-shared",
      subagent: { id: "w-abc123", type: "worker", parentRunId: "run-parent-shared" },
      onToolInputStream: (evt) =>
        streamEvents.push({ subagentId: evt.subagentId, blockId: evt.blockId }),
    });

    expect(streamEvents.length).toBe(3);
    for (const evt of streamEvents) {
      expect(evt.subagentId).toBe("w-abc123");
    }
  });

  it("distinct workers carry distinct subagentId values in the same parent process", async () => {
    // Two independent worker runs (simulating two Task dispatches in one parent run).
    const allEvents: Array<{ id: string }> = [];
    setupTwoTurnRun(makeStreamingApplyPatchMock("tc-w1", "src/a.ts"));
    await runAgentLoop({
      task: "worker A",
      repoPath: "/tmp",
      runId: "run-parent",
      subagent: { id: "w-A", type: "worker", parentRunId: "run-parent" },
      onToolInputStream: (evt) => allEvents.push({ id: evt.subagentId ?? "" }),
    });

    vi.clearAllMocks();
    setupTwoTurnRun(makeStreamingApplyPatchMock("tc-w2", "src/b.ts"));
    await runAgentLoop({
      task: "worker B",
      repoPath: "/tmp",
      runId: "run-parent",
      subagent: { id: "w-B", type: "worker", parentRunId: "run-parent" },
      onToolInputStream: (evt) => allEvents.push({ id: evt.subagentId ?? "" }),
    });

    const seen = new Set(allEvents.map((e) => e.id));
    expect(seen.has("w-A")).toBe(true);
    expect(seen.has("w-B")).toBe(true);
    expect(seen.has("")).toBe(false);
  });

  it("J.5: priorRunSummary prepends a PRIOR RUN CONTEXT block above the user task", async () => {
    // Capture the messages array passed to createChatCompletion to assert
    // the user message is wrapped with the framing block.
    const capturedMessages: Array<Array<{ role: string; content: string }>> = [];
    mocks.createChatCompletion.mockImplementation(async (params: unknown) => {
      const p = params as { messages: Array<{ role: string; content: string }> };
      capturedMessages.push(p.messages);
      return textResponse("done");
    });
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    await runAgentLoop({
      task: "Continue: complete the rename.",
      repoPath: "/tmp",
      runId: "run-j5-1",
      priorRunSummary:
        "APPLY_ROLLED_BACK\nYour apply_patch on src/x.ts was rolled back.\n" +
        '… Files restored: ["src/x.ts"]\n\nSuggested: the rename is partial; fan-out.',
    });

    expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
    const firstMessages = capturedMessages[0]!;
    const userMsg = firstMessages.find((m) => m.role === "user")!;
    expect(userMsg.content.startsWith("PRIOR RUN CONTEXT — ")).toBe(true);
    expect(userMsg.content).toContain("APPLY_ROLLED_BACK\n");
    expect(userMsg.content).toContain("Suggested: the rename is partial");
    expect(userMsg.content).toContain("END PRIOR RUN CONTEXT.");
    // The user's actual task lands after the framing.
    expect(userMsg.content).toMatch(/END PRIOR RUN CONTEXT\.\n\nContinue: complete the rename\./);
  });

  it("J.5: omitting priorRunSummary keeps the user task as-is (no framing block)", async () => {
    const capturedMessages: Array<Array<{ role: string; content: string }>> = [];
    mocks.createChatCompletion.mockImplementation(async (params: unknown) => {
      const p = params as { messages: Array<{ role: string; content: string }> };
      capturedMessages.push(p.messages);
      return textResponse("done");
    });
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    await runAgentLoop({
      task: "Just a regular task.",
      repoPath: "/tmp",
      runId: "run-j5-noop",
      // No priorRunSummary field.
    });

    const userMsg = capturedMessages[0]!.find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("Just a regular task.");
    expect(userMsg.content).not.toContain("PRIOR RUN CONTEXT");
  });

  it("J.5: empty-string priorRunSummary is treated as no-op", async () => {
    const capturedMessages: Array<Array<{ role: string; content: string }>> = [];
    mocks.createChatCompletion.mockImplementation(async (params: unknown) => {
      const p = params as { messages: Array<{ role: string; content: string }> };
      capturedMessages.push(p.messages);
      return textResponse("done");
    });
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    await runAgentLoop({
      task: "Empty prior summary path.",
      repoPath: "/tmp",
      runId: "run-j5-empty",
      priorRunSummary: "",
    });

    const userMsg = capturedMessages[0]!.find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("Empty prior summary path.");
  });

  it("agentLoop forwards onToolInputStream into executeTool's Task-dispatch input", async () => {
    // Capture the input object passed to executeTool — the field must contain
    // the same callback the parent provided, so the worker run can rewire it.
    const capturedInputs: Array<Record<string, unknown>> = [];
    mocks.executeTool.mockImplementation(
      async (_name: string, _args: unknown, _repo: string, _onProgress: unknown, inp: unknown) => {
        capturedInputs.push((inp as Record<string, unknown>) ?? {});
        return { success: true, output: "ok" };
      }
    );
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
    // Use read_file — apply_patch has a read-first guard that short-circuits
    // executeTool, while read_file goes straight through. Either way, the
    // assertion is the same: agentLoop's executeTool input carries
    // onToolInputStream so the Task dispatch path (which uses this same input)
    // can forward it to the worker subagent.
    mocks.createChatCompletion
      .mockResolvedValueOnce(
        toolCallResponse("read_file", { filePath: "x.ts" }, "tc-fwd-1")
      )
      .mockResolvedValueOnce(textResponse("Done."));

    const streamFn = vi.fn();
    await runAgentLoop({
      task: "verify forwarding",
      repoPath: "/tmp",
      runId: "run-fwd",
      onToolInputStream: streamFn,
    });

    expect(capturedInputs.length).toBeGreaterThanOrEqual(1);
    // Every executeTool call from agentLoop must carry the streaming callback
    // so the Task tool dispatch path can hand it to the worker subagent.
    for (const inp of capturedInputs) {
      expect(typeof inp.onToolInputStream).toBe("function");
    }
  });
});
