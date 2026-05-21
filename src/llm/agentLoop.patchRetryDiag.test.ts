/**
 * S.2.1 Commit 3: apply_patch retry JSONL diagnostic emission.
 * When apply_patch fails, the loop emits a structured log via log()
 * with { event, runId, iter, reason, filePath, attemptCount }.
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
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, log: mocks.log };
});

import { runAgentLoop, applyPatchRetryReason } from "./agentLoop.js";
import type { SelfCorrectTrigger } from "./agentLoop.js";

function makePatchCall(id: string, filePath = "src/target.ts") {
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
                  patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
                  intent: "modify",
                  scope: null,
                }),
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

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-patch-retry-diag-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ─── applyPatchRetryReason unit tests ────────────────────────────────────────

describe("applyPatchRetryReason", () => {
  it("maps find_not_found → find_mismatch", () => {
    expect(applyPatchRetryReason("apply_patch_find_not_found")).toBe("find_mismatch");
  });

  it("maps apply_patch_multiple_matches → multiple_matches", () => {
    expect(applyPatchRetryReason("apply_patch_multiple_matches")).toBe("multiple_matches");
  });

  it("maps apply_patch_syntax_broken_post_write → syntax_broken", () => {
    expect(applyPatchRetryReason("apply_patch_syntax_broken_post_write")).toBe("syntax_broken");
  });

  it("maps apply_patch_repeated_failure_same_file → repeated_failure", () => {
    expect(applyPatchRetryReason("apply_patch_repeated_failure_same_file")).toBe("repeated_failure");
  });

  it("maps apply_patch_no_read_first → no_read_first", () => {
    expect(applyPatchRetryReason("apply_patch_no_read_first")).toBe("no_read_first");
  });

  it("maps unknown trigger → unknown", () => {
    expect(applyPatchRetryReason("some_unknown_trigger")).toBe("unknown");
  });
});

// ─── integration: FIND mismatch emits reason: find_mismatch ──────────────────

describe("S.2.1 — apply_patch retry JSONL emission", () => {
  it("FIND mismatch emits [zone-apply-patch-retry] with reason: find_mismatch", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        // First call: read the file so the no-read-first guard doesn't intercept
        return {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "tc-read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ filePath: "src/target.ts", lineRange: null }),
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
      if (callCount === 2) return makePatchCall(`tc-patch`);
      return makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]");
    });
    // executeTool: read_file succeeds, apply_patch fails with find_not_found
    toolExecutorMock.executeTool.mockImplementation(async (toolName: string) => {
      if (toolName === "read_file") {
        return { success: true, output: "const x = 1;\n" };
      }
      if (toolName === "apply_patch") {
        return {
          success: false,
          output: "find content not found in src/target.ts",
          error: undefined,
        };
      }
      return { success: true, output: "" };
    });

    await runAgentLoop({
      task: "apply a patch",
      repoPath,
      runId: "test-run-123",
      maxIterationsOverride: 5,
    });

    const patchRetryCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-apply-patch-retry]"
    );
    expect(patchRetryCalls.length).toBeGreaterThanOrEqual(1);
    const firstPayload = JSON.parse(patchRetryCalls[0][1] as string);
    expect(firstPayload.event).toBe("apply_patch_retry");
    expect(firstPayload.reason).toBe("find_mismatch");
    expect(firstPayload.runId).toBe("test-run-123");
    expect(firstPayload.filePath).toBe("src/target.ts");
    expect(typeof firstPayload.iter).toBe("number");
    expect(typeof firstPayload.attemptCount).toBe("number");
  });

  it("run_command failure does NOT emit [zone-apply-patch-retry]", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "tc-1",
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({ command: "npm test", cwd: null }),
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
      return makeDoneResponse("[ZONE_VERIFICATION: tests_failed_unrelated]");
    });
    toolExecutorMock.executeTool.mockImplementation(async (toolName: string) => {
      if (toolName === "run_command") {
        return {
          success: false,
          output: "[exit_code=1 — npm test failed]\nTests: 1 failed",
          error: undefined,
        };
      }
      return { success: true, output: "" };
    });

    await runAgentLoop({
      task: "run tests",
      repoPath,
      runId: "test-run-456",
      maxIterationsOverride: 3,
    });

    const patchRetryCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-apply-patch-retry]"
    );
    expect(patchRetryCalls.length).toBe(0);
  });
});
