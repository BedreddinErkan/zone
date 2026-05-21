/**
 * Phase E — softIterWarn replaces iterCap hard cap.
 * - maxIterationsForRun is set to softIterWarn * 3 (safety ceiling).
 * - A soft-warn message is injected at iter === softIterWarn.
 * - Subagent loops bypass tier limits and use plan-computed budgets.
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
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

import { runAgentLoop } from "./agentLoop.js";
import { TIER_LIMITS } from "./tierLimits.js";
import type { TaskClassification } from "./taskClassifier.js";

function makeReadFileCall(id: string, filePath = "src/target.ts") {
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
                name: "read_file",
                arguments: JSON.stringify({ filePath, lineRange: null }),
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

function makeClassification(tier: "simple" | "medium" | "complex"): TaskClassification {
  return {
    tier,
    estimatedFiles: 1,
    estimatedIterations: 1,
    confidence: 0.9,
    classifierCostUsd: 0.001,
    classifierLatencyMs: 50,
    classifierModel: "test-model",
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-iter-budget-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "file content" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("Phase E — softIterWarn ceiling (softIterWarn * 3)", () => {
  it("simple-tier ceiling is softIterWarn * 3 = 45; exits via safety ceiling", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      // Vary filePath each iteration so the loop detector doesn't fire before the ceiling
      return makeReadFileCall(`tc-${callCount}`, `src/file_${callCount}.ts`);
    });

    const result = await runAgentLoop({
      task: "read a file",
      repoPath,
      maxIterations: 1, // plan-computed budget — tier raises it to softIterWarn * 3
      taskClassification: makeClassification("simple"),
    });

    // Safety ceiling exit now returns token_budget_exceeded
    expect(result.terminationReason).toBe("token_budget_exceeded");
    // Should have run the full simple-tier ceiling (softIterWarn * 3 = 45)
    const expectedCeiling = TIER_LIMITS.simple.softIterWarn * 3;
    expect(result.toolCallLog.length).toBeGreaterThanOrEqual(expectedCeiling - 2);
  });

  it("medium-tier ceiling is softIterWarn * 3 = 75; plan-computed budget is raised", async () => {
    let callCount = 0;
    // Exit after softIterWarn iterations with a done response so the test isn't too slow
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount <= TIER_LIMITS.medium.softIterWarn) {
        return makeReadFileCall(`tc-${callCount}`, `src/file_${callCount}.ts`);
      }
      return makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra] Done.");
    });

    const result = await runAgentLoop({
      task: "read a file",
      repoPath,
      maxIterations: 8, // plan-computed budget from a 2-step plan
      taskClassification: makeClassification("medium"),
    });

    // Ran past the plan-computed 8, ended at natural completion after softIterWarn+1 iters
    expect(result.terminationReason).toBe("natural_completion");
    expect(result.toolCallLog.length).toBeGreaterThanOrEqual(TIER_LIMITS.medium.softIterWarn - 1);
  });

  it("high maxIterations input is not reduced below softIterWarn * 3", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 20) return makeReadFileCall(`tc-${callCount}`, `src/file_${callCount}.ts`);
      return makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]");
    });

    const result = await runAgentLoop({
      task: "read a file",
      repoPath,
      maxIterations: 100, // far above simple softIterWarn * 3 = 45
      taskClassification: makeClassification("simple"),
    });

    // Loop ends via natural completion after 21 iterations (20 tool + 1 done)
    expect(result.terminationReason).toBe("natural_completion");
    expect(result.toolCallLog.length).toBeLessThanOrEqual(22);
  });

  it("subagent loop (no tier limits) uses the plan-computed budget directly", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      return makeReadFileCall(`tc-${callCount}`, `src/file_${callCount}.ts`);
    });

    const result = await runAgentLoop({
      task: "read a file",
      repoPath,
      maxIterationsOverride: 3, // subagent gets a small override
      subagent: { id: "sub-1", type: "explore", parentRunId: "parent-1" },
    });

    // Subagent hits safety ceiling at 3 iters (no tier limits applied)
    expect(result.terminationReason).toBe("token_budget_exceeded");
    // Subagent should respect its own override (3), not be raised to any tier cap
    expect(result.toolCallLog.length).toBeLessThanOrEqual(5);
  });
});
