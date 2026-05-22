/**
 * Cache-stability regression tests for Phase J residual anti-patterns.
 *
 * Verifies that coaching injection and loop-warning injection append to the
 * existing role:"tool" message rather than pushing a standalone role:"user"
 * message (which would bust the Anthropic prefix cache by adding +3 messages
 * per coaching/warning iter instead of +2).
 *
 * Companion to agentLoop.phaseJCoaching.test.ts (which covers the main
 * coaching path fixed in 52f24da).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

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

import { runAgentLoop } from "./agentLoop.js";

function makeRunCommandResponse(id: string) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: "run_command", arguments: JSON.stringify({ command: "npm test" }) },
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
      { message: { content: text, tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-cache-stability-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.pruneStaleReads.mockReset();
  mocks.emitContextPruned.mockReset();

  mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => ({
    pruned: msgs,
    stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: (msgs as unknown[]).length },
  }));
  mocks.emitContextPruned.mockImplementation(() => {});
  toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
    if (name === "run_command")
      return {
        success: false,
        exitCode: 1,
        output: "[exit_code=1] Tests failed: 2 failures\n  at src/foo.test.ts:42",
      };
    return { success: true, output: "" };
  });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("Cache stability — coaching and loop-warning injection", () => {
  it("T.1: message count grows by exactly +2 per coaching iter (not +3)", async () => {
    // Iters 1 and 2 run run_command → fail → coaching appended to role:tool.
    // Iter 3 returns done.
    //
    // Capturing message counts synchronously inside the mock avoids the
    // reference-sharing trap (pruneStaleReads returns the same array reference,
    // so reading .length after the run would see the final mutated length for
    // every call). Capturing .length in the mock body gets the value at call
    // time, which is stable.
    const snapshots: number[] = [];
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(
      async (params: { messages: unknown[] }) => {
        snapshots.push(params.messages.length);
        callCount++;
        if (callCount === 1) return makeRunCommandResponse("tc-1");
        if (callCount === 2) return makeRunCommandResponse("tc-2");
        return makeDoneResponse("[ZONE_VERIFICATION: tests_inconclusive]");
      }
    );

    await runAgentLoop({
      task: "fix failing tests",
      repoPath,
      maxIterationsOverride: 6,
    });

    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    // Each coaching iter must add exactly 2 messages (assistant tool_call +
    // tool result with coaching text appended inside it). +3 would mean a
    // standalone coaching message was pushed as a new role:"user" entry.
    expect(snapshots[1] - snapshots[0]).toBe(2);
    expect(snapshots[2] - snapshots[1]).toBe(2);
  });

  it("T.2: loop-warning notice appended to role:tool, not pushed as standalone role:user", async () => {
    // Three identical run_command calls (same args → same hashToolCall hash) →
    // loop detector warns at count=3 (WARN_THRESHOLD). executeTool succeeds so
    // coaching does NOT fire — only the loop warning fires on iter 3.
    //
    // Using run_command (not apply_patch) avoids the no-read-first enforcement
    // path, which uses a continue that skips loop detection for apply_patch.
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) return makeRunCommandResponse(`tc-${callCount}`);
      return makeDoneResponse("[ZONE_VERIFICATION: tests_inconclusive]");
    });
    // run_command succeeds → failureDetected=false → no coaching → only loop
    // warning fires at count=3.
    toolExecutorMock.executeTool.mockImplementation(async () => ({
      success: true,
      exitCode: 0,
      output: "ok",
    }));

    await runAgentLoop({
      task: "fix foo",
      repoPath,
      maxIterationsOverride: 6,
    });

    const calls = mocks.createChatCompletion.mock.calls as Array<
      [{ messages: Array<{ role: string; content: unknown }> }]
    >;
    // 3 run_command iters + 1 done iter = 4 LLM calls.
    expect(calls.length).toBeGreaterThanOrEqual(4);

    // Iter 4's LLM call receives the messages that include the loop-warning
    // injected during iter 3. Reference sharing is fine here because we check
    // message content (string values), not array length.
    const msgs = calls[3][0].messages;

    // After the fix: no standalone role:"user" containing loop-warning text.
    const standaloneLW = msgs.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        (m.content as string).includes("Zone loop-warning")
    );
    expect(standaloneLW).toBeUndefined();

    // Warning text IS present inside a role:"tool" message.
    const toolWithLW = msgs.find(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        (m.content as string).includes("[Zone loop-warning]")
    );
    expect(toolWithLW).toBeDefined();

    // Alternation preserved — no two adjacent messages share the same role.
    for (let i = 1; i < msgs.length; i++) {
      expect(
        msgs[i]!.role,
        `consecutive same-role at [${i - 1}] and [${i}]: "${msgs[i]!.role}"`
      ).not.toBe(msgs[i - 1]!.role);
    }
  });
});
