/**
 * Fix 1 tests: staging map is flushed on every terminal exit path of runAgentLoop.
 *
 * Three early-exit paths previously bypassed finalizeRun entirely, discarding
 * any staged patches:
 *  - token_budget_exceeded (iter-mid budget guard)
 *  - loop_detected        (via handleToolResult early_exit)
 *  - natural_completion   (the "good" path — regression guard: no double-flush)
 *
 * Strategy: mock finalizeStaging as a spy, seed staging via a mock executeTool
 * that populates input.stagingFiles when apply_patch is called, then assert the
 * spy was (or was not) called for each exit path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
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
}));

// Replace finalizeStaging + verifyAndFinalize with spies so we can assert
// call counts without touching the filesystem or running tsc.
vi.mock("./verification/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./verification/index.js")>();
  return {
    ...actual,
    finalizeStaging: vi.fn().mockResolvedValue({
      flushed: true,
      verification: { status: "skipped", reason: "no_staged_files" },
      filesFlushed: 1,
      flushFailures: 0,
    }),
    verifyAndFinalize: vi.fn().mockResolvedValue({
      kind: "skipped",
      reason: "no_staged_files",
    }),
  };
});

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

vi.mock("../usage/usageTracker.js", () => ({
  getUsage: vi.fn(async () => ({ totalCostUsd: 0, totalTokens: 0, byProvider: {}, byModel: {}, runs: 0 })),
  recordRunSummary: vi.fn(async () => {}),
  recordRunRetry: vi.fn(async () => {}),
  recordRun: vi.fn(async () => {}),
}));

import { runAgentLoop } from "./agentLoop.js";
import { finalizeStaging, verifyAndFinalize } from "./verification/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeApplyPatchResponse() {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call_ap_1",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              patch: "--- a/src/target.ts\n+++ b/src/target.ts\n@@ -1 +1 @@\n-old\n+new\n",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeReadFileResponse(id: string) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filePath: "src/target.ts" }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeDoneResponse(text = "All done. [ZONE_VERIFICATION: tests_skipped_no_infra]") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// High token count to push tokenBudgetRatio >= TOKEN_BUDGET_HARD (0.95).
// TOKEN_BUDGET_CAP = 800_000; 0.95 * 800_000 = 760_000.
function makeHighTokenResponse() {
  return {
    choices: [{ message: { content: "synthesizing...", tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 760_001, completion_tokens: 1, total_tokens: 760_002 },
  };
}

let repoPath: string;
let mockFinalizeStaging: Mock;
let mockVerifyAndFinalize: Mock;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-staging-flush-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();

  mockFinalizeStaging = finalizeStaging as Mock;
  mockVerifyAndFinalize = verifyAndFinalize as Mock;

  // Re-apply implementations after vitest's per-test mockReset clears them.
  mockFinalizeStaging.mockResolvedValue({
    flushed: true,
    verification: { status: "skipped", reason: "no_staged_files" },
    filesFlushed: 1,
    flushFailures: 0,
  });
  mockVerifyAndFinalize.mockResolvedValue({
    kind: "skipped",
    reason: "no_staged_files",
  });

  // executeTool: populate the staging map when apply_patch is called so
  // persistStagingOnError finds non-empty staging and calls finalizeStaging.
  toolExecutorMock.executeTool.mockImplementation(
    async (
      toolName: string,
      _args: unknown,
      rp: string,
      _onProgress: unknown,
      execInput: { stagingFiles?: Map<string, string> } | undefined
    ) => {
      if (toolName === "apply_patch" && execInput?.stagingFiles) {
        execInput.stagingFiles.set(path.resolve(rp, "src/target.ts"), "const x = 1;");
        return { success: true, output: "Patch staged: 1 block(s) in src/target.ts" };
      }
      return { success: true, output: "// content" };
    }
  );
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Fix 1 — staging flushed on early-exit paths", () => {
  it("token_budget_exceeded: finalizeStaging called once with staged content", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse()) // iter 0: apply_patch → staging populated
      .mockResolvedValueOnce(makeHighTokenResponse())  // iter 1: high tokens → budget exit fires
      .mockResolvedValue(makeDoneResponse());          // synthesizeTokenBudgetExit wrapup call

    const result = await runAgentLoop({ task: "rename x", repoPath, runId: "test-flush-budget" });

    expect(result.terminationReason).toBe("token_budget_exceeded");
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(1);
    const [[call]] = mockFinalizeStaging.mock.calls;
    expect(call.stagingFiles.size).toBe(1);
    expect(call.framework).toBeUndefined();
    expect(call.verifyMode).toBe("warn");
  });

  it("loop_detected: finalizeStaging called once with staged content", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse())   // iter 0: apply_patch → staging populated
      .mockResolvedValueOnce(makeReadFileResponse("rf1")) // iter 1: read_file (count=1)
      .mockResolvedValueOnce(makeReadFileResponse("rf2")) // iter 2: read_file (count=2)
      .mockResolvedValueOnce(makeReadFileResponse("rf3")) // iter 3: read_file (count=3, WARN)
      .mockResolvedValue(makeReadFileResponse("rf4"));    // iter 4: read_file (count=4, TERMINATE)

    const result = await runAgentLoop({ task: "rename x", repoPath, runId: "test-flush-loop" });

    expect(result.terminationReason).toBe("loop_detected");
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(1);
    const [[call]] = mockFinalizeStaging.mock.calls;
    expect(call.stagingFiles.size).toBe(1);
    expect(call.framework).toBeUndefined();
    expect(call.verifyMode).toBe("warn");
  });

  it("natural_completion: verifyAndFinalize called, finalizeStaging NOT called from persistStagingOnError", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse()) // iter 0: apply_patch → staging populated
      .mockResolvedValue(makeDoneResponse());          // iter 1: done → natural_completion

    const result = await runAgentLoop({ task: "rename x", repoPath, runId: "test-flush-natural" });

    expect(result.terminationReason).toBe("natural_completion");
    // verifyAndFinalize should be called by finalizeRun (normal path)
    expect(mockVerifyAndFinalize).toHaveBeenCalledTimes(1);
    // finalizeStaging must NOT be called from persistStagingOnError (no double-flush)
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(0);
  });
});
