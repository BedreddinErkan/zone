/**
 * F.1 regression: truncated/unparseable tool_use args must produce
 * TOOL_ARGS_TRUNCATED coaching, NOT empty {} → READ_REQUIRED/MISSING_ARG.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  debugLog: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: mocks.debugLog,
  errorLog: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTruncatedPatchCall(toolName: string, badJson: string) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call-truncated-1",
          type: "function",
          function: { name: toolName, arguments: badJson },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function makeDoneResponse() {
  return {
    choices: [{
      message: { content: "Done — re-issued with smaller calls.", tool_calls: null },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ── fixture ───────────────────────────────────────────────────────────────────

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-args-parse-fail-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.debugLog.mockReset();
  mocks.log.mockReset();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("F.1: truncated tool_use args → TOOL_ARGS_TRUNCATED, not {} → READ_REQUIRED", () => {
  it("short-circuits to TOOL_ARGS_TRUNCATED when apply_patch args are non-empty but invalid JSON", async () => {
    const truncatedJson = '{"filePath":"src/ui/index.html","patch":"--- FIND ---\\nincomplete...';

    mocks.createChatCompletion.mockResolvedValueOnce(
      makeTruncatedPatchCall("apply_patch", truncatedJson),
    );
    mocks.createChatCompletion.mockResolvedValueOnce(makeDoneResponse());

    const result = await runAgentLoop({
      task: "patch a large file",
      repoPath,
      mode: "patch",
      maxIterations: 5,
    });

    // The loop completes via the done response (not a terminal error)
    expect(result.success).toBe(true);

    // executeTool was never called — the short-circuit fired before dispatch
    expect(toolExecutorMock.executeTool).not.toHaveBeenCalled();

    // The second LLM call received the TOOL_ARGS_TRUNCATED coaching message
    const secondCallMessages: Array<{ role: string; content?: string }> =
      mocks.createChatCompletion.mock.calls[1]?.[0]?.messages ?? [];
    const toolResultMsg = secondCallMessages.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("TOOL_ARGS_TRUNCATED"),
    );
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg?.content).toContain("apply_patch");
    expect(toolResultMsg?.content).toContain("smaller/split calls");

    // The coaching message does NOT contain the misleading MISSING_ARG path
    expect(toolResultMsg?.content).not.toContain("MISSING_ARG");
    expect(toolResultMsg?.content).not.toContain("READ_REQUIRED");

    // Telemetry fired via the sink-reaching `log`, not the gated `debugLog`
    const parseFailed = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-tool-args-parse-failed]",
    );
    expect(parseFailed).toBeDefined();
    const payload = JSON.parse(parseFailed![1] as string) as Record<string, unknown>;
    expect(payload.tool).toBe("apply_patch");
    expect(payload.argsLen).toBeGreaterThan(0);
    // The raw-argument preview is gone — this payload reaches a sink that persists to
    // disk, and a preview of unparsed apply_patch/write_file args is file content.
    expect(payload.argsPreview).toBeUndefined();
    // Classified by message shape only; this fixture's truncation cuts off mid-string.
    expect(payload.parseErrorClass).toBe("unterminated_string");
    // Exact key set, not just the three fields above individually: a future field added
    // alongside a correctly-computed parseErrorClass (e.g. a raw message carried for
    // "more detail") would pass every assertion above unnoticed. This one fails loudly
    // and names the new key, forcing that decision to be deliberate instead of silent.
    expect(Object.keys(payload).sort()).toEqual(["argsLen", "parseErrorClass", "tool"]);
  });

  it("does NOT trigger TOOL_ARGS_TRUNCATED for legitimately empty args (ternary else path)", async () => {
    // A tool call with genuinely empty arguments should parse to {} cleanly
    // (e.g. a tool that takes no args). This ensures the catch is not triggered.
    mocks.createChatCompletion.mockResolvedValueOnce({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-empty-args",
            type: "function",
            function: { name: "read_file", arguments: "" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    mocks.createChatCompletion.mockResolvedValueOnce(makeDoneResponse());

    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "file content" });

    await runAgentLoop({
      task: "read a file",
      repoPath,
      mode: "patch",
      maxIterations: 5,
    });

    // No TOOL_ARGS_TRUNCATED telemetry — the ternary else took over
    const parseFailed = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-tool-args-parse-failed]",
    );
    expect(parseFailed).toBeUndefined();
  });
});
