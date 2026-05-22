/**
 * Phase K.5: org policy integration tests for the agentLoop cap gate.
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
}));

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: mocks.readDailyUsdCapOverride,
  readTierSettings: vi.fn(() => ({})),
  readAutoAuditSetting: vi.fn(() => true),
  writeTierSettings: vi.fn(),
  writeAutoAuditSetting: vi.fn(),
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
      { message: { content: "done", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;
let tmpDir: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-policy-loop-"));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-policy-files-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.getUsage.mockReset();
  mocks.readDailyUsdCapOverride.mockReset();
  mocks.readDailyUsdCapOverride.mockReturnValue(undefined);
  delete process.env.ZONE_ORG_POLICY_PATH;
  delete process.env.ZONE_DAILY_USD_CAP;
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ZONE_ORG_POLICY_PATH;
  delete process.env.ZONE_DAILY_USD_CAP;
});

function writePolicyFile(content: object): string {
  const p = path.join(tmpDir, "policy.json");
  fs.writeFileSync(p, JSON.stringify(content), "utf8");
  return p;
}

describe("K.5 — org policy integration", () => {
  it("policy dailyUsdCap: 5 wins over user_override $20; spend $7 → cap exceeded", async () => {
    const policyPath = writePolicyFile({ dailyUsdCap: 5 });
    process.env.ZONE_ORG_POLICY_PATH = policyPath;
    mocks.readDailyUsdCapOverride.mockReturnValue(20); // user override $20
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(7.0)); // spent $7

    const result = await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
    });

    // Policy $5 cap < $7 spent → blocked
    expect(result.terminationReason).toBe("daily_usd_cap_exceeded");
    expect(result.summary).toContain("$5.00");
    expect(mocks.createChatCompletion).not.toHaveBeenCalled();
  });

  it("policy with monthlyUsdCap only → run proceeds, unsupported field logged", async () => {
    const policyPath = writePolicyFile({ monthlyUsdCap: 100 });
    process.env.ZONE_ORG_POLICY_PATH = policyPath;
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(0.5)); // low spend
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    const result = await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
    });

    // monthlyUsdCap is unsupported (Phase M) → run should proceed
    expect(result.terminationReason).not.toBe("daily_usd_cap_exceeded");
    expect(mocks.createChatCompletion).toHaveBeenCalled();
  });

  it("missing policy file path → run proceeds with K.1 chain unchanged", async () => {
    process.env.ZONE_ORG_POLICY_PATH = path.join(tmpDir, "nonexistent.json");
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(0.5));
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    const result = await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
    });

    // Missing file → policy absent → fall through to default $10 cap; $0.5 < $10 → proceeds
    expect(result.terminationReason).not.toBe("daily_usd_cap_exceeded");
    expect(mocks.createChatCompletion).toHaveBeenCalled();
  });

  it("policy dailyUsdCap: 0 (unlimited) → bypasses user_override cap; run proceeds even with high spend", async () => {
    const policyPath = writePolicyFile({ dailyUsdCap: 0 });
    process.env.ZONE_ORG_POLICY_PATH = policyPath;
    mocks.readDailyUsdCapOverride.mockReturnValue(5); // user wants $5 cap
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(99.0)); // high spend
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    const result = await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
    });

    // Policy 0 = unlimited → user override $5 is irrelevant → run proceeds
    expect(result.terminationReason).not.toBe("daily_usd_cap_exceeded");
    expect(mocks.createChatCompletion).toHaveBeenCalled();
  });
});
