/**
 * Issue 3: auto-continue on finish_reason:"length"
 *
 * When the LLM hits max_tokens mid-answer, the natural-completion path should:
 * (a) fire continuation call(s) with tool_choice:"none" and concatenate the chunks
 * (b) append a truncation marker if still finish_reason:"length" after MAX_CONTINUATIONS
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import {
  installScript,
  scriptText,
  scriptTruncated,
} from "../test/fixtures/scriptedLlm.js";

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

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-trunc-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("auto-continue on finish_reason:length", () => {
  it("fires one continuation call and concatenates chunks into summary", async () => {
    installScript(mocks.createChatCompletion, [
      scriptTruncated("Part A "),
      scriptText("Part B"),
    ]);

    const result = await runAgentLoop({
      task: "explain recursion",
      repoPath,
      runId: "test-trunc-concat",
    });

    expect(result.terminationReason).toBe("natural_completion");
    // main call + 1 continuation
    expect(mocks.createChatCompletion.mock.calls.length).toBe(2);
    expect(result.summary).toContain("Part A");
    expect(result.summary).toContain("Part B");
    expect(result.summary).not.toContain("⚠️ Output truncated");
  });

  it("appends truncation marker after MAX_CONTINUATIONS exhausted", async () => {
    // main call + 2 continuations all return finish_reason:"length"
    installScript(
      mocks.createChatCompletion,
      [scriptTruncated("A"), scriptTruncated("B"), scriptTruncated("C")],
      { final: scriptTruncated("D") }
    );

    const result = await runAgentLoop({
      task: "explain something at great length",
      repoPath,
      runId: "test-trunc-marker",
    });

    expect(result.terminationReason).toBe("natural_completion");
    // main call + 2 continuations (MAX_CONTINUATIONS = 2)
    expect(mocks.createChatCompletion.mock.calls.length).toBe(3);
    expect(result.summary).toContain("⚠️ Output truncated");
    expect(result.summary).toContain("say 'continue'");
  });

  it("continuation call uses tool_choice:none and no tools field", async () => {
    installScript(mocks.createChatCompletion, [
      scriptTruncated("Partial answer "),
      scriptText("finished."),
    ]);

    await runAgentLoop({
      task: "explain a concept",
      repoPath,
      runId: "test-trunc-toolchoice",
    });

    expect(mocks.createChatCompletion.mock.calls.length).toBe(2);
    const continuationParams = mocks.createChatCompletion.mock.calls[1][0];
    expect(continuationParams.tool_choice).toBe("none");
    expect(continuationParams.tools).toBeUndefined();
  });

  it("budget is recorded for each continuation call", async () => {
    // Use non-default usage to distinguish main vs continuation cost.
    const mainUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const contUsage = { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 };
    installScript(mocks.createChatCompletion, [
      scriptTruncated("Part A", mainUsage),
      scriptText("Part B", contUsage),
    ]);

    const result = await runAgentLoop({
      task: "explain something",
      repoPath,
      runId: "test-trunc-budget",
    });

    // costUsd must account for both calls, not just the main call.
    // With gpt-4o rates ($2.50/M in, $10/M out):
    // main: (100/1M)*2.50 + (50/1M)*10 = 0.00025 + 0.0005 = 0.00075
    // cont: (200/1M)*2.50 + (80/1M)*10 = 0.0005 + 0.0008 = 0.0013
    // total ~= 0.00205
    const singleCallCost = (100 / 1_000_000) * 2.5 + (50 / 1_000_000) * 10;
    expect(result.costUsd).toBeGreaterThan(singleCallCost);
  });
});
