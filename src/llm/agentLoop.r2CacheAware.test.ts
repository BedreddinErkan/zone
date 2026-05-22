/**
 * U.1 Commit 3: R.2 cache-aware pruning.
 * When R.2 freshly prunes messages (blocksReplaced increases), the loop should
 * preserve the previous pruning state to keep the Anthropic prefix cache stable.
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
  pruneStaleReads: vi.fn(),
  emitContextPruned: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("./contextPruner.js", () => ({
  pruneStaleReads: mocks.pruneStaleReads,
  emitContextPruned: mocks.emitContextPruned,
}));

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, log: mocks.log };
});

import { runAgentLoop } from "./agentLoop.js";

function makeReadFileCall(id: string, filePath = "src/foo.ts") {
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
                arguments: JSON.stringify({ filePath, lineRange: null }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
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
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-r2-cache-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.pruneStaleReads.mockReset();
  mocks.emitContextPruned.mockReset();
  mocks.log.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "file content" });
  // Default: pruneStaleReads passes messages through unmodified, blocksReplaced=0
  mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => ({
    pruned: msgs,
    stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: 0 },
  }));
  mocks.emitContextPruned.mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("U.1 Commit 3 — R.2 cache-aware pruning", () => {
  it("when blocksReplaced stays 0 across iters, passes freshly-pruned messages normally", async () => {
    let callCount = 0;
    const capturedMessages: unknown[][] = [];

    mocks.createChatCompletion.mockImplementation(async (params: { messages: unknown[] }) => {
      callCount += 1;
      capturedMessages.push(params.messages);
      if (callCount <= 2) return makeReadFileCall(`tc-${callCount}`, `src/f${callCount}.ts`);
      return makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]");
    });

    // pruneStaleReads always returns 0 blocks replaced
    mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => ({
      pruned: msgs,
      stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: msgs.length },
    }));

    await runAgentLoop({
      task: "read files",
      repoPath,
      runId: "r2-stable-test",
      maxIterationsOverride: 5,
    });

    expect(capturedMessages.length).toBeGreaterThanOrEqual(2);
    // No [zone-cache-r2-skip] should have been emitted
    const skipCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-r2-skip]"
    );
    expect(skipCalls.length).toBe(0);
  });

  it("when blocksReplaced increases, emits [zone-cache-r2-skip] and uses previous pruned state", async () => {
    let callCount = 0;
    const messagesPassedToLLM: unknown[][] = [];

    mocks.createChatCompletion.mockImplementation(async (params: { messages: unknown[] }) => {
      callCount += 1;
      messagesPassedToLLM.push([...params.messages]);
      if (callCount === 1) return makeReadFileCall("tc-1", "src/a.ts");
      if (callCount === 2) return makeReadFileCall("tc-2", "src/b.ts");
      return makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]");
    });

    let pruneCallCount = 0;
    mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => {
      pruneCallCount += 1;
      if (pruneCallCount <= 1) {
        // First call: no pruning
        return {
          pruned: msgs,
          stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: msgs.length },
        };
      }
      // Second call: simulate new pruning (blocksReplaced increases to 1)
      return {
        pruned: msgs.map((m, i) =>
          i === 0 ? { ...(m as object), content: "[Earlier read elided]" } : m
        ),
        stats: { blocksReplaced: 1, charsSaved: 500, blocksKept: msgs.length - 1 },
      };
    });

    await runAgentLoop({
      task: "read two files",
      repoPath,
      runId: "r2-skip-test",
      maxIterationsOverride: 5,
    });

    // [zone-cache-r2-skip] should have been emitted when new pruning occurred
    const skipCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-r2-skip]"
    );
    expect(skipCalls.length).toBeGreaterThanOrEqual(1);
    const skipPayload = JSON.parse(skipCalls[0][1] as string);
    expect(skipPayload.prevBlocks).toBe(0);
    expect(skipPayload.newBlocks).toBe(1);
    expect(skipPayload.runId).toBe("r2-skip-test");
  });

  it("when no previous state exists (iter 0), always uses freshly pruned", async () => {
    let callCount = 0;

    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeReadFileCall("tc-1");
      return makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]");
    });

    // First call already shows blocksReplaced=1 (unlikely in practice but tests the guard)
    mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => ({
      pruned: msgs,
      stats: { blocksReplaced: 1, charsSaved: 100, blocksKept: 0 },
    }));

    await runAgentLoop({
      task: "first iter test",
      repoPath,
      runId: "r2-first-iter-test",
      maxIterationsOverride: 3,
    });

    // On iter 0, prevR2PrunedMessages is null so no skip should fire
    const skipCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-r2-skip]"
    );
    expect(skipCalls.length).toBe(0);
  });
});
