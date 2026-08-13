/**
 * Phase K.1: daily USD cap enforcement gate integration tests.
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
  getUsage: vi.fn(),
  readDailyUsdCapOverride: vi.fn<() => number | undefined>(),
  log: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
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
  recordRunSummary: vi.fn(async () => undefined),
  recordRunRetry: vi.fn(async () => undefined),
}));

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: mocks.readDailyUsdCapOverride,
  readTierSettings: vi.fn(() => ({})),
  writeTierSettings: vi.fn(),
  writeDailyUsdCapOverride: vi.fn(),
  getTierSettingsPath: vi.fn(() => "/tmp/tier-limits.json"),
}));

import { runAgentLoop } from "./agentLoop.js";

function makeUsageAggregate(totalCostUsd: number) {
  return {
    period: "day" as const,
    totalRuns: 1,
    totalTokens: 1000,
    totalCostUsd,
    byProvider: {},
    byModel: {},
  };
}

function makeDoneResponse() {
  return {
    choices: [
      {
        message: { content: "done", tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-usd-cap-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.getUsage.mockReset();
  mocks.readDailyUsdCapOverride.mockReset();
  mocks.log.mockReset();
  // Default: no user override, no ZONE_DAILY_USD_CAP env
  mocks.readDailyUsdCapOverride.mockReturnValue(undefined);
  delete process.env.ZONE_DAILY_USD_CAP;
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
  delete process.env.ZONE_DAILY_USD_CAP;
});

describe("K.1 — daily USD cap gate", () => {
  it("terminates with daily_usd_cap_exceeded when spend >= cap", async () => {
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(10.0));
    // default cap = $10.00 via env fallback → default

    const result = await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
    });

    expect(result.terminationReason).toBe("daily_usd_cap_exceeded");
    expect(result.success).toBe(false);
    expect(result.summary).toContain("Daily USD cap");
    // LLM should never have been called
    expect(mocks.createChatCompletion).not.toHaveBeenCalled();
  });

  it("proceeds normally when spend is under cap", async () => {
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(5.0));
    process.env.ZONE_DAILY_USD_CAP = "10";
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    const result = await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
    });

    expect(result.terminationReason).not.toBe("daily_usd_cap_exceeded");
    expect(mocks.createChatCompletion).toHaveBeenCalled();
  });

  it("cap=0 (unlimited) never blocks even when spend is large", async () => {
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(999.0));
    mocks.readDailyUsdCapOverride.mockReturnValue(0); // user set unlimited
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    const result = await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
    });

    expect(result.terminationReason).not.toBe("daily_usd_cap_exceeded");
    expect(mocks.createChatCompletion).toHaveBeenCalled();
  });

  it("subagent loop skips the cap gate entirely", async () => {
    // Even if spend exceeds cap, subagent loops must not be blocked
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(999.0));
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    const result = await runAgentLoop({
      task: "do something as subagent",
      repoPath,
      userId: "user-1",
      subagent: { id: "sa-1", type: "worker", parentRunId: "parent-run-1" },
    });

    expect(result.terminationReason).not.toBe("daily_usd_cap_exceeded");
    // gate skipped means getUsage was never called for cap enforcement
    expect(mocks.getUsage).not.toHaveBeenCalled();
  });
});

describe("Phase O (Patch B) — zone-graceful-degrade pre-check suppression", () => {
  it("does NOT emit [zone-graceful-degrade] when costUsd=0 (pre-check cap block, run never started)", async () => {
    // Cap is set, spend is at cap — daily_usd_cap_exceeded before any LLM call
    process.env.ZONE_DAILY_USD_CAP = "5";
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(5.0));

    const result = await runAgentLoop({
      task: "blocked by cap",
      repoPath,
      runId: "cap-precheck-run-1",
      userId: "user-1",
    });

    expect(result.terminationReason).toBe("daily_usd_cap_exceeded");
    expect(result.costUsd ?? 0).toBe(0);

    // Pre-check fires with costUsd=0 and canResume=true — this is NOT a graceful degrade,
    // the run never incurred any cost. The emit must be suppressed.
    const degradeCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-graceful-degrade]"
    );
    expect(degradeCalls).toHaveLength(0);
  });

  it("DOES emit [zone-graceful-degrade] for mid-run exhaustion (costUsd > 0)", async () => {
    // Spend under cap at dispatch time, LLM runs and completes normally
    process.env.ZONE_DAILY_USD_CAP = "10";
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(1.0));
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({
      task: "run that succeeds",
      repoPath,
      runId: "natural-complete-run-1",
      userId: "user-1",
    });

    // natural_completion terminates gracefulDegrade=false but costUsd > 0 so emit fires
    const degradeCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-graceful-degrade]"
    );
    expect(degradeCalls).toHaveLength(1);
    const payload = JSON.parse(String(degradeCalls[0][1]));
    expect(payload.terminationReason).toBe("natural_completion");
    expect(payload.runId).toBe("natural-complete-run-1");
  });
});
