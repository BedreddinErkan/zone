/**
 * Phase D tests: runInvestigationFlow — prompt injection, tool-set
 * enforcement, and natural-termination via mocked LLM.
 */

import { describe, expect, it, vi } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => ({
  executeTool: mocks.executeTool,
  withStagingTempFlush: mocks.withStagingTempFlush,
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
    mocks.executeTool.mockResolvedValue({ success: true, output: "" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

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

  it("system prompt does not mention apply_patch or write_file tools", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("## Answer\nNothing to report.")
    );
    mocks.executeTool.mockResolvedValue({ success: true, output: "" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    await runInvestigationFlow({
      task: "Test tool exclusion in prompt",
      repoPath: "/tmp/fake-repo",
    });

    const firstCall = mocks.createChatCompletion.mock.calls[0];
    const messages: Array<{ role: string; content: string }> = firstCall[0].messages ?? firstCall[0];
    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg!.content).not.toContain("apply_patch");
    expect(systemMsg!.content).not.toContain("write_file");
  });
});

describe("runInvestigationFlow — natural termination", () => {
  it("returns ok:true and chatResponse when LLM emits final text with no tool call", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse(
        "## getRunCost References\n\n- `src/usage/usageTracker.ts:220`\n- `src/api/server.ts:2790`\n- `src/api/server.ts:3126`"
      )
    );
    mocks.executeTool.mockResolvedValue({ success: true, output: "" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

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
    mocks.executeTool.mockResolvedValue({ success: true, output: "src/usage/usageTracker.ts:220: export function getRunCost..." });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

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
    mocks.executeTool.mockResolvedValue({ success: true, output: "" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());

    const result = await runInvestigationFlow({
      task: "Find any file",
      repoPath: "/tmp/fake-repo",
    });

    expect(result.applyPatches).toEqual([]);
    expect(result.fileDiffs).toEqual([]);
  });
});
