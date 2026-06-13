import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import { installScript, scriptRefusal } from "../test/fixtures/scriptedLlm.js";

// Refusal fixture: finish_reason:"content_filter" at agentLoop.ts:3616 exits cleanly
// (terminationReason:"natural_completion") instead of burning the iteration budget.

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

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop.js";
import { createLLMClient } from "./factory.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-refusal-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("safety classifier refusal — clean exit", () => {
  it("exits with terminationReason:natural_completion, not max_iterations", async () => {
    installScript(mocks.createChatCompletion, [scriptRefusal()]);

    const result = await runAgentLoop({
      task: "fix the auth bug",
      repoPath,
      runId: "test-refusal-1",
    });

    expect(mocks.createChatCompletion.mock.calls.length).toBe(1);
    expect(result.terminationReason).toBe("natural_completion");
    expect(result.refusal).toBeTruthy();
    expect(result.refusal).toContain("Request declined by safety classifier.");
  });

  it("costUsd reflects exactly one scripted response (prompt=10, output=5, model=gpt-4o)", async () => {
    installScript(mocks.createChatCompletion, [scriptRefusal()]);

    const result = await runAgentLoop({
      task: "fix the auth bug",
      repoPath,
      runId: "test-refusal-cost",
    });

    // gpt-4o rates: input=$2.50/Mtok, output=$10/Mtok (default openai model)
    const expected = (10 / 1_000_000) * 2.50 + (5 / 1_000_000) * 10;
    expect(result.costUsd).toBeCloseTo(expected, 7);
  });
});
