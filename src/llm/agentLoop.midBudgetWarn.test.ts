/**
 * Phase I Lane 2.1: 70% token budget mid-warn injection.
 * One-shot user-message injected when cumulativeTokens crosses 70% of cap.
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

// Keep the USD cap gate from blocking test runs.
vi.mock("../usage/usageTracker.js", () => ({
  getUsage: vi.fn(async () => ({ totalCostUsd: 0, totalTokens: 0, byProvider: {}, byModel: {}, runs: 0 })),
  recordRunSummary: vi.fn(async () => {}),
  recordRunRetry: vi.fn(async () => {}),
  recordRun: vi.fn(async () => {}),
}));

import { runAgentLoop } from "./agentLoop.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDoneResponse(text = "[ZONE_VERIFICATION: tests_skipped_no_infra]") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-mid-warn-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function midWarnLogs() {
  return mocks.log.mock.calls.filter(
    (c: unknown[]) => c[0] === "[zone-token-budget-mid-warn]"
  );
}

// effectiveTokenBudgetCap with no taskClassification = TIER_LIMITS.medium.tokenBudgetCap = 600_000
// TOKEN_BUDGET_MID_WARN = 0.70 → threshold = 420_000
const CAP = 600_000;
const THRESHOLD = Math.floor(CAP * 0.70) + 1; // 420_001

describe("Phase I Lane 2.1 — 70% token budget mid-warn injection", () => {
  it("does NOT emit mid-warn when tokenBudgetBaseTokens is below 70% threshold", async () => {
    await runAgentLoop({
      task: "below-threshold task",
      repoPath,
      runId: "test-below",
      tokenBudgetBaseTokens: THRESHOLD - 2, // 419_999
    });

    expect(midWarnLogs()).toHaveLength(0);
  });

  it("emits [zone-token-budget-mid-warn] exactly once when threshold crossed", async () => {
    await runAgentLoop({
      task: "at-threshold task",
      repoPath,
      runId: "test-at",
      tokenBudgetBaseTokens: THRESHOLD,
    });

    expect(midWarnLogs()).toHaveLength(1);
  });

  it("mid-warn log payload contains runId and tokenRatio >= 0.70", async () => {
    await runAgentLoop({
      task: "payload check",
      repoPath,
      runId: "test-payload",
      tokenBudgetBaseTokens: THRESHOLD,
    });

    const logs = midWarnLogs();
    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0][1] as string);
    expect(payload.runId).toBe("test-payload");
    expect(payload.tokenRatio).toBeGreaterThanOrEqual(0.70);
    expect(typeof payload.iter).toBe("number");
    expect(typeof payload.ts).toBe("string");
  });

  it("does NOT re-inject on subsequent iterations (idempotent)", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount < 4) {
        return {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: `tc-${callCount}`,
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ filePath: "src/foo.ts", lineRange: null }),
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
      return makeDoneResponse();
    });
    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "const x = 1;" });

    await runAgentLoop({
      task: "multi-iter above threshold",
      repoPath,
      runId: "test-idempotent",
      tokenBudgetBaseTokens: THRESHOLD,
    });

    expect(midWarnLogs().length).toBeLessThanOrEqual(1);
  });

  it("injected message text contains '70%' and 'converge'", async () => {
    let firstCallMessages: unknown[] | null = null;
    mocks.createChatCompletion.mockImplementation(async ({ messages }: { messages: unknown[] }) => {
      if (firstCallMessages === null) firstCallMessages = messages;
      return makeDoneResponse();
    });

    await runAgentLoop({
      task: "message text check",
      repoPath,
      runId: "test-text",
      tokenBudgetBaseTokens: THRESHOLD,
    });

    const msgs = firstCallMessages ?? [];
    const midWarnMsg = (msgs as Array<{ role?: string; content?: string }>)
      .find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("70%"));
    expect(midWarnMsg).toBeDefined();
    expect(midWarnMsg?.content).toContain("converge");
  });
});
