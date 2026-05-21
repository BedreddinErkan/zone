/**
 * U.2.C Commit 3: [zone-coaching-rule] JSONL emission on test_failed coaching.
 *
 * When the agent triggers test_failed self-correction, the loop must emit
 * [zone-coaching-rule] with decision: in_scope | out_of_scope | unclear,
 * parsedFailingFile, and modifiedFiles.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  pruneStaleReads: vi.fn(),
  emitContextPruned: vi.fn(),
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

vi.mock("./contextPruner.js", () => ({
  pruneStaleReads: mocks.pruneStaleReads,
  emitContextPruned: mocks.emitContextPruned,
}));

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, log: mocks.log };
});

import { runAgentLoop } from "./agentLoop.js";

function makeApplyPatchResponse(id: string, filePath: string) {
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
                name: "apply_patch",
                arguments: JSON.stringify({
                  filePath,
                  patch: "--- FIND ---\nold\n--- REPLACE ---\nnew",
                  intent: "modify",
                }),
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
              function: {
                name: "run_command",
                arguments: JSON.stringify({ command: "npm test" }),
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
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-coaching-jsonl-"));
  mocks.createChatCompletion.mockReset();
  mocks.executeTool.mockReset();
  mocks.withStagingTempFlush.mockReset();
  mocks.pruneStaleReads.mockReset();
  mocks.emitContextPruned.mockReset();
  mocks.log.mockReset();

  mocks.withStagingTempFlush.mockImplementation(async (fn: () => Promise<void>) => fn());
  mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => ({
    pruned: msgs,
    stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: msgs.length },
  }));
  mocks.emitContextPruned.mockImplementation(() => {});
  mocks.executeTool.mockImplementation(async (name: string) => {
    if (name === "apply_patch") return { success: true, output: "patched" };
    return { success: true, output: "" };
  });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("U.2.C Commit 3 — [zone-coaching-rule] JSONL", () => {
  it("emits [zone-coaching-rule] with out_of_scope when failing file not in modified files", async () => {
    // Agent patches src/utils/isMonorepo.ts, but test fails in src/ui/Button.test.ts
    const failOutput =
      "[exit_code=1] FAIL src/ui/Button.test.ts\n● Button > renders\n  AssertionError at src/ui/Button.test.ts:42";
    mocks.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") return { success: true, output: "patched" };
      if (name === "run_command") return { success: false, exitCode: 1, output: failOutput };
      return { success: true, output: "" };
    });

    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeApplyPatchResponse("tc-1", "src/utils/isMonorepo.ts");
      if (callCount === 2) return makeRunCommandResponse("tc-2");
      return makeDoneResponse("[ZONE_VERIFICATION: tests_failed_unrelated]");
    });

    await runAgentLoop({
      task: "add isMonorepo support",
      repoPath,
      runId: "coaching-rule-test",
      maxIterationsOverride: 6,
    });

    const coachingCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-coaching-rule]"
    );
    expect(coachingCalls.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(coachingCalls[0][1] as string);
    expect(payload.event).toBe("coaching_rule_trigger");
    expect(payload.rule).toBe("test_failure_scope_check");
    expect(payload.decision).toBe("out_of_scope");
    expect(payload.runId).toBe("coaching-rule-test");
    expect(typeof payload.iter).toBe("number");
  });

  it("emits decision=unclear when no failing file can be parsed from output", async () => {
    const vagueOutput =
      "[exit_code=1] Error: some vague failure without a file path\n  at unknown location";
    mocks.executeTool.mockImplementation(async (name: string) => {
      if (name === "run_command") return { success: false, exitCode: 1, output: vagueOutput };
      return { success: true, output: "" };
    });

    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeRunCommandResponse("tc-1");
      return makeDoneResponse("[ZONE_VERIFICATION: tests_inconclusive]");
    });

    await runAgentLoop({
      task: "run tests",
      repoPath,
      runId: "coaching-unclear-test",
      maxIterationsOverride: 4,
    });

    const coachingCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-coaching-rule]"
    );
    expect(coachingCalls.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(coachingCalls[0][1] as string);
    expect(payload.decision).toBe("unclear");
  });

  it("includes modifiedFiles array and iter in the JSONL payload", async () => {
    const failOutput =
      "[exit_code=1] FAIL src/ui/Widget.test.ts\n● Widget > mounts\n  at src/ui/Widget.test.ts:15";
    mocks.executeTool.mockImplementation(async (name: string) => {
      if (name === "run_command") return { success: false, exitCode: 1, output: failOutput };
      return { success: true, output: "" };
    });

    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeRunCommandResponse("tc-1");
      return makeDoneResponse("[ZONE_VERIFICATION: tests_failed_unrelated]");
    });

    await runAgentLoop({
      task: "run tests",
      repoPath,
      runId: "coaching-modfiles-test",
      maxIterationsOverride: 6,
    });

    const coachingCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-coaching-rule]"
    );
    expect(coachingCalls.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(coachingCalls[0][1] as string);
    expect(Array.isArray(payload.modifiedFiles)).toBe(true);
    expect(typeof payload.iter).toBe("number");
    expect(payload.iter).toBeGreaterThanOrEqual(1);
  });
});
