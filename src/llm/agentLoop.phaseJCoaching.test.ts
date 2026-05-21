/**
 * Phase J coaching: coaching appended to tool_result, not a separate user message.
 *
 * Probe v2 (8126b47) traced iter-10/11 cache bust to a 754-token user message
 * injected by Phase J's apply-rollback feedback after npm test failure. The
 * injection violated assistant-tool alternation (+3 messages/iter instead of +2)
 * and shifted manifest position, busting the Anthropic prefix cache from that
 * iter forward.
 *
 * Fix (this commit): append coaching to the existing test_result tool message
 * instead of pushing a new role:"user" message. Preserves alternation; agent
 * still sees coaching inline with test output.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  pruneStaleReads: vi.fn(),
  emitContextPruned: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => ({
  clearCommandCacheForRun: vi.fn(() => undefined),
  executeTool: mocks.executeTool,
  withStagingTempFlush: mocks.withStagingTempFlush,
}));

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
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-phase-j-coaching-"));
  mocks.createChatCompletion.mockReset();
  mocks.executeTool.mockReset();
  mocks.withStagingTempFlush.mockReset();
  mocks.pruneStaleReads.mockReset();
  mocks.emitContextPruned.mockReset();

  mocks.withStagingTempFlush.mockImplementation(async (fn: () => Promise<void>) => fn());
  mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => ({
    pruned: msgs,
    stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: (msgs as unknown[]).length },
  }));
  mocks.emitContextPruned.mockImplementation(() => {});
  mocks.executeTool.mockImplementation(async (name: string) => {
    if (name === "run_command")
      return { success: false, exitCode: 1, output: "[exit_code=1] Tests failed: 2 failures\n  at src/foo.test.ts:42" };
    return { success: true, output: "" };
  });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("Phase J coaching — append to tool_result, not separate user message", () => {
  it("T.1: coaching text lands in role:tool content, not a standalone role:user message", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeRunCommandResponse("tc-1");
      return makeDoneResponse("[ZONE_VERIFICATION: tests_inconclusive]");
    });

    await runAgentLoop({
      task: "fix failing tests",
      repoPath,
      maxIterationsOverride: 4,
    });

    const calls = mocks.createChatCompletion.mock.calls as Array<
      [{ messages: Array<{ role: string; content: unknown }> }]
    >;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // Iter 2's LLM request carries the coaching content appended to the tool result.
    const msgs2 = calls[1][0].messages;

    // T.1a: no standalone role:"user" message containing "[Zone coaching"
    const standaloneCoaching = msgs2.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("[Zone coaching")
    );
    expect(standaloneCoaching).toBeUndefined();

    // T.1b: coaching text is present inside a role:"tool" message
    const toolWithCoaching = msgs2.find(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        (m.content as string).includes("[Zone coaching")
    );
    expect(toolWithCoaching).toBeDefined();
  });

  it("T.2: no consecutive same-role messages — alternation preserved through failure+coaching iter", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeRunCommandResponse("tc-1");
      return makeDoneResponse("[ZONE_VERIFICATION: tests_inconclusive]");
    });

    await runAgentLoop({
      task: "fix tests",
      repoPath,
      maxIterationsOverride: 4,
    });

    const calls = mocks.createChatCompletion.mock.calls as Array<
      [{ messages: Array<{ role: string }> }]
    >;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // Check the message sequence delivered to iter 2: no two adjacent same-role entries.
    const msgs = calls[1][0].messages;
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i]!.role, `consecutive same-role at [${i - 1}] and [${i}]: "${msgs[i]!.role}"`).not.toBe(
        msgs[i - 1]!.role
      );
    }
  });
});
