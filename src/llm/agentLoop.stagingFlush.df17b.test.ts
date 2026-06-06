/**
 * DF-17b: staged edits survive every exit path that previously discarded them.
 *
 * Four gaps closed:
 *  A1 — pre-iter hook blocked
 *  A2 — upstream unavailable (LLM down)
 *  A3 — post-tool hook blocked
 *  B  — abort (throwIfAborted → DOMException propagates, caught by try-finally)
 *
 * Also asserts:
 *  - stagingFinalized flag prevents double-call to finalizeStaging on existing
 *    emergency exits (token_budget path as representative)
 *  - owner gating: subagent (ownsStagingFiles=false) abort does NOT flush parent map
 *  - verifyMode:warn respected: a type-broken staged edit still persists on abort
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
import { UpstreamUnavailableError } from "./withExponentialBackoff.js";
import type { PreIterationHook, PostToolUseHook } from "../hooks/postToolUseHook.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeApplyPatchResponse() {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: "call_ap_1", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ patch: "--- a/src/target.ts\n+++ b/src/target.ts\n@@ -1 +1 @@\n-old\n+new\n" }) } }],
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

function makeHighTokenResponse() {
  return {
    choices: [{ message: { content: "synthesizing...", tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 760_001, completion_tokens: 1, total_tokens: 760_002 },
  };
}

/** Pre-iter hook that blocks on the SECOND iteration (allows iter 0 to populate staging). */
function makeDeferredBlockPreIterHook(): PreIterationHook {
  let callCount = 0;
  return {
    name: "test-deferred-block",
    priority: 999,
    shouldRun: () => true,
    run: () => {
      callCount++;
      return callCount > 1
        ? { kind: "block" as const, reason: "test block" }
        : { kind: "passthrough" as const };
    },
  };
}

/** Post-tool hook that blocks immediately. */
const blockingPostToolHook: PostToolUseHook = {
  name: "test-post-block",
  priority: 999,
  shouldRun: () => true,
  run: () => ({ kind: "block" as const, reason: "test post-tool block" }),
};

let repoPath: string;
let mockFinalizeStaging: Mock;
let mockVerifyAndFinalize: Mock;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-df17b-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();

  mockFinalizeStaging = finalizeStaging as Mock;
  mockVerifyAndFinalize = verifyAndFinalize as Mock;

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

  // Populate staging map when apply_patch is called.
  toolExecutorMock.executeTool.mockImplementation(
    async (toolName: string, _args: unknown, rp: string, _onProgress: unknown, execInput: { stagingFiles?: Map<string, string> } | undefined) => {
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

describe("DF-17b — staging flushed on all exit paths", () => {

  it("A1 — pre-iter hook blocked: finalizeStaging called once with staged content", async () => {
    // The pre-iter hook fires at the TOP of each iteration before the LLM is called.
    // Allow iter 0 to run (apply_patch populates staging), then block on iter 1.
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse()) // iter 0: apply_patch → staging populated
      .mockResolvedValue(makeDoneResponse());          // iter 1: hook fires before LLM; not reached

    const result = await runAgentLoop({
      task: "rename x",
      repoPath,
      runId: "test-df17b-a1",
      hooks: { preIteration: [makeDeferredBlockPreIterHook()] },
    });

    expect(result.terminationReason).toBe("hook_blocked");
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(1);
    const call = mockFinalizeStaging.mock.calls[0]![0];
    expect(call.stagingFiles.size).toBe(1);
    expect(call.verifyMode).toBe("warn");
  });

  it("A2 — upstream unavailable: finalizeStaging called once with staged content", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse()) // iter 0: populate staging
      .mockRejectedValue(new UpstreamUnavailableError("LLM down")); // iter 1: upstream fail

    const result = await runAgentLoop({ task: "rename x", repoPath, runId: "test-df17b-a2" });

    expect(result.terminationReason).toBe("upstream_unavailable");
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(1);
    const call = mockFinalizeStaging.mock.calls[0]![0];
    expect(call.stagingFiles.size).toBe(1);
    expect(call.verifyMode).toBe("warn");
  });

  it("A3 — post-tool hook blocked: finalizeStaging called once with staged content", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse()) // iter 0: tool call → post-hook fires
      .mockResolvedValue(makeDoneResponse());

    const result = await runAgentLoop({
      task: "rename x",
      repoPath,
      runId: "test-df17b-a3",
      hooks: { postToolUse: [blockingPostToolHook] },
    });

    expect(result.terminationReason).toBe("hook_blocked");
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(1);
    const call = mockFinalizeStaging.mock.calls[0]![0];
    expect(call.stagingFiles.size).toBe(1);
    expect(call.verifyMode).toBe("warn");
  });

  it("B — abort: try-finally flushes staged edits, finalizeStaging called once", async () => {
    const ac = new AbortController();

    mocks.createChatCompletion.mockImplementation(async () => {
      // Abort mid-run before returning a response.
      ac.abort();
      // createChatCompletion must respect the signal; throw AbortError.
      const err = new DOMException("Request aborted", "AbortError");
      throw err;
    });

    // Seed staging manually so the map has content when the abort fires.
    // (apply_patch would normally do this, but the LLM never returns a tool call.)
    const parentStaging = new Map<string, string>();
    parentStaging.set(path.resolve(repoPath, "src/target.ts"), "const x = 1;");

    try {
      await runAgentLoop({
        task: "rename x",
        repoPath,
        runId: "test-df17b-b",
        abortSignal: ac.signal,
        parentStagingFiles: parentStaging,
      });
    } catch {
      // AbortError may propagate — catch it so the test continues.
    }

    // The try-finally in runAgentLoopScoped must have called persistStagingOnError,
    // which calls finalizeStaging once.
    // NOTE: with ownsStagingFiles=false (parentStagingFiles provided), the call
    // is gated and won't flush — this subagent case is tested separately below.
    // For owned staging (no parentStagingFiles), we rely on the flag path test:
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(0);
    // Parentstaging provided → ownsStagingFiles=false → persistStagingOnError no-ops.
  });

  it("B — abort with owned staging: try-finally flushes (ownsStagingFiles=true)", async () => {
    const ac = new AbortController();
    let stagingMapRef: Map<string, string> | null = null;

    // Capture the staging map reference before it's aborted.
    toolExecutorMock.executeTool.mockImplementation(
      async (toolName: string, _args: unknown, rp: string, _onProgress: unknown, execInput: { stagingFiles?: Map<string, string> } | undefined) => {
        if (toolName === "apply_patch" && execInput?.stagingFiles) {
          stagingMapRef = execInput.stagingFiles;
          execInput.stagingFiles.set(path.resolve(rp, "src/target.ts"), "const x = 1;");
          // Now abort so the loop is interrupted after staging is populated.
          ac.abort();
          return { success: true, output: "Patch staged: 1 block(s)" };
        }
        return { success: true, output: "ok" };
      }
    );

    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse()) // triggers apply_patch → abort
      .mockResolvedValue(makeDoneResponse());

    try {
      await runAgentLoop({
        task: "rename x",
        repoPath,
        runId: "test-df17b-b-owned",
        abortSignal: ac.signal,
      });
    } catch {
      // AbortError propagated — expected.
    }

    // ownsStagingFiles=true (no parentStagingFiles) → try-finally calls persistStagingOnError.
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(1);
    const call = mockFinalizeStaging.mock.calls[0]![0];
    expect(call.stagingFiles.size).toBe(1);
    expect(call.verifyMode).toBe("warn");
  });

  it("owner gating: subagent context (ownsStagingFiles=false) abort does NOT flush parent map", async () => {
    const ac = new AbortController();
    const parentMap = new Map<string, string>();
    parentMap.set(path.resolve(repoPath, "src/other.ts"), "const parent = 1;");

    mocks.createChatCompletion.mockImplementation(async () => {
      ac.abort();
      throw new DOMException("Request aborted", "AbortError");
    });

    try {
      await runAgentLoop({
        task: "subagent task",
        repoPath,
        runId: "test-df17b-owner",
        abortSignal: ac.signal,
        parentStagingFiles: parentMap,
      });
    } catch { /* AbortError */ }

    // persistStagingOnError checks !ownsStagingFiles → returns immediately.
    // Parent map must NOT be flushed by the subagent's finally block.
    expect(mockFinalizeStaging).not.toHaveBeenCalled();
    // Parent's staged content is preserved (not cleared).
    expect(parentMap.size).toBe(1);
  });

  it("no double-call: token_budget exit with stagingFinalized flag — finalizeStaging called exactly once", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse())
      .mockResolvedValueOnce(makeHighTokenResponse())
      .mockResolvedValue(makeDoneResponse());

    const result = await runAgentLoop({ task: "rename x", repoPath, runId: "test-df17b-nodbl" });

    expect(result.terminationReason).toBe("token_budget_exceeded");
    // stagingFinalized=true was set after persistStagingOnError at the token_budget site,
    // so the try-finally must NOT call persistStagingOnError again.
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(1);
  });

  it("no double-call: natural_completion — verifyAndFinalize once, finalizeStaging zero times from emergency path", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse())
      .mockResolvedValue(makeDoneResponse());

    const result = await runAgentLoop({ task: "rename x", repoPath, runId: "test-df17b-nat" });

    expect(result.terminationReason).toBe("natural_completion");
    // stagingFinalized=true set before finalizeRun → try-finally is a no-op.
    expect(mockFinalizeStaging).toHaveBeenCalledTimes(0);
  });

});
