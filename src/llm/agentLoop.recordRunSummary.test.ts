/**
 * Phase Y.2.3.obs: verify that recordRunSummary write failures are surfaced
 * via [zone-run-summary-write-failed] instead of silently swallowed.
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
  recordRunSummary: vi.fn(),
  getUsage: vi.fn(),
  readDailyUsdCapOverride: vi.fn<() => number | undefined>(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../usage/usageTracker.js", () => ({
  getUsage: mocks.getUsage,
  recordExecution: vi.fn(),
  readRecords: vi.fn(() => []),
  recordRunSummary: mocks.recordRunSummary,
  getRunCost: vi.fn(() => 0),
  recordRunSummarySync: vi.fn(),
}));

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: mocks.readDailyUsdCapOverride,
  readTierSettings: vi.fn(() => ({})),
  writeTierSettings: vi.fn(),
  writeDailyUsdCapOverride: vi.fn(),
  getTierSettingsPath: vi.fn(() => "/tmp/tier-limits.json"),
}));

import { runAgentLoop } from "./agentLoop.js";

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "done", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-rec-sum-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.recordRunSummary.mockReset();
  mocks.getUsage.mockReset();
  mocks.readDailyUsdCapOverride.mockReset();
  mocks.readDailyUsdCapOverride.mockReturnValue(0); // unlimited
  mocks.getUsage.mockResolvedValue({
    period: "day" as const,
    totalRuns: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    byProvider: {},
    byModel: {},
  });
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
  mocks.recordRunSummary.mockResolvedValue(undefined); // default: success
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("Y.2.3.obs — recordRunSummary failure visibility", () => {
  it("logs [zone-run-summary-write-failed] when recordRunSummary rejects", async () => {
    mocks.recordRunSummary.mockRejectedValue(new Error("simulated disk failure"));

    const consoleSpy = vi.spyOn(console, "log");

    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-obs-123",
    });

    const failedCalls = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0] === "[zone-run-summary-write-failed]"
    );
    expect(failedCalls).toHaveLength(1);

    const payload = JSON.parse(String(failedCalls[0][1])) as Record<string, unknown>;
    expect(payload.runId).toBe("test-run-obs-123");
    expect(payload.error).toBe("simulated disk failure");
    expect(typeof payload.ts).toBe("string");

    consoleSpy.mockRestore();
  });
});
