/**
 * Phase Q.2 integration tests: loop detection wired into agentLoop.
 *
 * Strategy: mock the LLM factory to return repeated identical read_file
 * tool calls so the sliding-window detector fires; mock executeTool so
 * the loop doesn't touch the filesystem.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

// ── hoisted mocks ────────────────────────────────────────────────────────────

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
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

// ── import under test ────────────────────────────────────────────────────────

import { runAgentLoop } from "./agentLoop.js";
import { TERMINATE_THRESHOLD, WARN_THRESHOLD } from "./loopDetector.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReadFileCall(id: string) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ filePath: "src/target.ts" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeDoneResponse(text: string) {
  return {
    choices: [
      {
        message: { content: text, tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ── fixture ──────────────────────────────────────────────────────────────────

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-loop-detect-"));
  resetToolExecutorMock(toolExecutorMock);
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "// file content" });
  toolExecutorMock.withStagingTempFlush.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("agentLoop loop detection (Q.2)", () => {
  it("terminates and sets terminationReason=loop_detected after TERMINATE_THRESHOLD identical calls", async () => {
    // LLM returns the same read_file call TERMINATE_THRESHOLD times,
    // then the loop should never reach the text response.
    for (let i = 0; i < TERMINATE_THRESHOLD + 2; i += 1) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileCall(`call-${i}`));
    }
    mocks.createChatCompletion.mockResolvedValueOnce(makeDoneResponse("done"));

    const result = await runAgentLoop({
      task: "read the same file repeatedly",
      repoPath,
      mode: "patch",
      maxIterations: 20,
    });

    expect(result.terminationReason).toBe("loop_detected");
    expect(result.success).toBe(false);
    expect(result.loopDetected).toMatchObject({
      toolName: "read_file",
      count: TERMINATE_THRESHOLD,
    });
  });

  it("emits loop_warning_emitted SSE at WARN_THRESHOLD and loop_detected_terminal at TERMINATE_THRESHOLD", async () => {
    for (let i = 0; i < TERMINATE_THRESHOLD + 2; i += 1) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileCall(`call-${i}`));
    }
    mocks.createChatCompletion.mockResolvedValueOnce(makeDoneResponse("done"));

    const events: Array<{ type: string; count?: number }> = [];
    await runAgentLoop({
      task: "read same file",
      repoPath,
      mode: "patch",
      maxIterations: 20,
      onStructuredEvent: (evt) => {
        const e = evt as { type?: string; count?: number };
        if (e.type === "loop_warning_emitted" || e.type === "loop_detected_terminal") {
          events.push({ type: String(e.type), count: e.count });
        }
      },
    });

    const warning = events.find((e) => e.type === "loop_warning_emitted");
    const terminal = events.find((e) => e.type === "loop_detected_terminal");

    expect(warning).toBeDefined();
    expect(warning?.count).toBe(WARN_THRESHOLD);
    expect(terminal).toBeDefined();
    expect(terminal?.count).toBe(TERMINATE_THRESHOLD);
  });

  it("appends loop-warning to role:tool when the warn threshold is reached", async () => {
    for (let i = 0; i < TERMINATE_THRESHOLD + 2; i += 1) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileCall(`call-${i}`));
    }
    mocks.createChatCompletion.mockResolvedValueOnce(makeDoneResponse("done"));

    await runAgentLoop({
      task: "read same file",
      repoPath,
      mode: "patch",
      maxIterations: 20,
    });

    // After the warn threshold is hit, the warning text is appended to the
    // preceding role:"tool" message (not pushed as a standalone role:"user"
    // turn) so that assistant-tool alternation is preserved and the Anthropic
    // prefix cache is not busted.
    const calls = mocks.createChatCompletion.mock.calls as Array<[{ messages: Array<{ role: string; content: string }> }]>;
    const allMessages = calls.flatMap(([req]) => req.messages ?? []);
    const warnMsg = allMessages.find(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.includes("same arguments") &&
        m.content.includes("loop")
    );
    expect(warnMsg).toBeDefined();
  });

  it("does NOT trigger for distinct tool calls even when count exceeds TERMINATE_THRESHOLD", async () => {
    // Each call uses a different filePath → detector never fires.
    for (let i = 0; i < TERMINATE_THRESHOLD + 2; i += 1) {
      mocks.createChatCompletion.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: `call-${i}`,
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ filePath: `src/file-${i}.ts` }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    mocks.createChatCompletion.mockResolvedValueOnce(makeDoneResponse("All done [ZONE_VERIFICATION: no_verification_attempted]"));

    const result = await runAgentLoop({
      task: "read different files",
      repoPath,
      mode: "patch",
      maxIterations: 20,
    });

    expect(result.terminationReason).not.toBe("loop_detected");
    expect(result.loopDetected).toBeUndefined();
  });
});
