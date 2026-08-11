/**
 * Phase D + D.1 tests: runInvestigationFlow — prompt injection, tool-set
 * enforcement, natural-termination, and zone-investigation-summary telemetry.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const toolExecutorMock = vi.hoisted(() => ({
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  clearCommandCacheForRun: vi.fn(),
  clearCommandCacheForTest: vi.fn(),
  clearOutlineCacheForTest: vi.fn(),
  isMemoizableCommand: vi.fn(),
  computeCommandFingerprint: vi.fn(),
  truncateCommandOutput: vi.fn(),
  resolveAgentPath: vi.fn(),
  resolveRunCommandCwd: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  log: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: mocks.debugLog,
  errorLog: vi.fn(),
}));

import { runInvestigationFlow } from "./investigationFlow.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function textResponse(content: string) {
  return {
    choices: [
      {
        message: { content, tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function toolCallResponse(name: string, args: Record<string, unknown>, id = "tc-1") {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runInvestigationFlow — prompt injection", () => {
  it("emits INVESTIGATION mode keywords in the first system message sent to LLM", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("## Answer\nFound nothing notable.")
    );
    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
    toolExecutorMock.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    await runInvestigationFlow({
      task: "Test prompt injection",
      repoPath: "/tmp/fake-repo",
    });

    const firstCall = mocks.createChatCompletion.mock.calls[0];
    const messages: Array<{ role: string; content: string }> = firstCall[0].messages ?? firstCall[0];
    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content.toLowerCase()).toMatch(/read-only|investigation mode/);
  });

  it("system prompt does not offer apply_patch or write_file as callable tools", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("## Answer\nNothing to report.")
    );
    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
    toolExecutorMock.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    await runInvestigationFlow({
      task: "Test tool exclusion in prompt",
      repoPath: "/tmp/fake-repo",
    });

    const firstCall = mocks.createChatCompletion.mock.calls[0];
    const messages: Array<{ role: string; content: string }> = firstCall[0].messages ?? firstCall[0];
    const systemMsg = messages.find((m) => m.role === "system");
    // Narrowed from a blanket not.toContain (this session's tool-absence-notice
    // arc): the investigation system prompt now legitimately names withheld tools
    // by exact name, in a comma-list sentence, precisely so the agent knows not to
    // attempt them ("TOOLS NOT AVAILABLE THIS RUN ... apply_patch, write_file ...
    // not a permission error"). That is correct, intended behaviour, not a leak.
    // What this test actually guards against — apply_patch/write_file being
    // described as AVAILABLE tools — is the "- toolname" bullet format the
    // "Tools available:" section renders every offered tool in; the notice's own
    // prose never takes that shape, so this stays a precise, not weakened, check.
    expect(systemMsg!.content).not.toMatch(/^- apply_patch\b/m);
    expect(systemMsg!.content).not.toMatch(/^- write_file\b/m);
  });
});

describe("runInvestigationFlow — natural termination", () => {
  it("returns ok:true and chatResponse when LLM emits final text with no tool call", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse(
        "## getRunCost References\n\n- `src/usage/usageTracker.ts:220`\n- `src/api/server.ts:2790`\n- `src/api/server.ts:3126`"
      )
    );
    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
    toolExecutorMock.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    const result = await runInvestigationFlow({
      task: "which files reference getRunCost?",
      repoPath: "/tmp/fake-repo",
    });

    expect(result.ok).toBe(true);
    expect(result.decisionMode).toBe("investigation");
    expect(result.chatResponse).toContain("getRunCost");
    expect(result.applyPatches).toEqual([]);
    expect(result.fileDiffs).toEqual([]);
  });

  it("records tool calls in toolCallLog when agent uses a search tool before answering", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(
        toolCallResponse("search_in_files", { pattern: "getRunCost", glob: "**/*.ts" })
      )
      .mockResolvedValueOnce(
        textResponse("## Answer\n- `src/usage/usageTracker.ts:220` — definition\n- `src/api/server.ts:2790`")
      );
    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "src/usage/usageTracker.ts:220: export function getRunCost..." });
    toolExecutorMock.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    const result = await runInvestigationFlow({
      task: "which files reference getRunCost?",
      repoPath: "/tmp/fake-repo",
    });

    expect(result.ok).toBe(true);
    expect(result.toolCallLog.length).toBeGreaterThanOrEqual(1);
    const searchCall = result.toolCallLog.find((c) => c.tool === "search_in_files");
    expect(searchCall).toBeDefined();
  });

  it("returns empty applyPatches and fileDiffs (investigation never writes)", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("## Summary\nNo files found.")
    );
    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
    toolExecutorMock.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    const result = await runInvestigationFlow({
      task: "Find any file",
      repoPath: "/tmp/fake-repo",
    });

    expect(result.applyPatches).toEqual([]);
    expect(result.fileDiffs).toEqual([]);
  });
});

// ── telemetry: zone-investigation-summary ────────────────────────────────────

describe("runInvestigationFlow — zone-investigation-summary telemetry (Phase D.1)", () => {
  beforeEach(() => {
    resetToolExecutorMock(toolExecutorMock);
    mocks.log.mockClear();
    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
    toolExecutorMock.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
  });

  it("emits [zone-investigation-summary] log after each run", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("Found `src/usage/usageTracker.ts:220` and `src/api/server.ts:2790`.")
    );

    await runInvestigationFlow({
      task: "which files reference getRunCost?",
      repoPath: "/tmp/fake-repo",
      runId: "run-telem-001",
    });

    const summaryCall = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-investigation-summary]"
    );
    expect(summaryCall).toBeDefined();
    const payload = JSON.parse(String(summaryCall![1]));
    expect(payload.event).toBe("investigation_summary");
    expect(payload.runId).toBe("run-telem-001");
    expect(typeof payload.toolCallCount).toBe("number");
    expect(typeof payload.ts).toBe("string");
  });

  it("citationCount in summary counts distinct backtick-path references", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse(
        "## Results\n" +
        "- `src/usage/usageTracker.ts:220` — definition\n" +
        "- `src/api/server.ts:2790` — chat route\n" +
        "- `src/api/server.ts:3126` — investigate route\n" +
        "- `src/core/runLlmPatchFlow.ts:6023` — patch flow"
      )
    );

    await runInvestigationFlow({
      task: "find getRunCost",
      repoPath: "/tmp/fake-repo",
    });

    const summaryCall = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-investigation-summary]"
    );
    const payload = JSON.parse(String(summaryCall![1]));
    expect(payload.citationCount).toBeGreaterThanOrEqual(3);
  });

  it("summary includes query truncated to 100 chars", async () => {
    const longQuery = "x".repeat(150);
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("Nothing found.")
    );

    await runInvestigationFlow({ task: longQuery, repoPath: "/tmp/fake-repo" });

    const summaryCall = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-investigation-summary]"
    );
    const payload = JSON.parse(String(summaryCall![1]));
    expect(payload.query.length).toBeLessThanOrEqual(100);
  });
});
