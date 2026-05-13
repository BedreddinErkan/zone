/**
 * S.2.1 Commit 2: tier iterCap is used as both floor and ceiling.
 * A 1-step plan computes maxIterations=6 (WORKER_ITER_FLOOR), but the
 * tier iterCap (simple=15, medium=25) must raise it to the full tier budget.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => ({
  executeTool: mocks.executeTool,
  withStagingTempFlush: mocks.withStagingTempFlush,
}));

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
    needsSubagent: tier !== "simple",
    confidence: 0.9,
    classifierCostUsd: 0.001,
    classifierLatencyMs: 50,
    classifierModel: "test-model",
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-iter-budget-"));
  mocks.createChatCompletion.mockReset();
  mocks.executeTool.mockReset();
  mocks.withStagingTempFlush.mockReset();
  mocks.withStagingTempFlush.mockImplementation(async (fn: () => Promise<void>) => fn());
  mocks.executeTool.mockResolvedValue({ success: true, output: "file content" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("S.2.1 — tier iterCap as floor and ceiling", () => {
  it("simple-tier plan-computed budget (1 step → 6) is raised to iterCap=15", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      // Vary filePath each iteration so the loop detector doesn't fire before max_iterations
      return makeReadFileCall(`tc-${callCount}`, `src/file_${callCount}.ts`);
    });

    const result = await runAgentLoop({
      task: "read a file",
      repoPath,
      maxIterations: 1, // plan-computed budget from a 1-step plan (WORKER_ITER_FLOOR=6 → effectively 1 here)
      taskClassification: makeClassification("simple"),
    });

    expect(result.terminationReason).toBe("max_iterations");
    // Should have run the full simple-tier iterCap=15 iterations, not just 1
    expect(result.toolCallLog.length).toBeGreaterThanOrEqual(TIER_LIMITS.simple.iterCap - 1);
  });

  it("medium-tier plan-computed budget (2 steps → 8) is raised to iterCap=25", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      return makeReadFileCall(`tc-${callCount}`, `src/file_${callCount}.ts`);
    });

    const result = await runAgentLoop({
      task: "read a file",
      repoPath,
      maxIterations: 8, // plan-computed budget from a 2-step plan
      taskClassification: makeClassification("medium"),
    });

    expect(result.terminationReason).toBe("max_iterations");
    // Should run the full medium-tier iterCap=25, not just 8
    expect(result.toolCallLog.length).toBeGreaterThanOrEqual(15);
  });

  it("plan budget that EXCEEDS iterCap is capped down (ceiling still works)", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 20) return makeReadFileCall(`tc-${callCount}`, `src/file_${callCount}.ts`);
      return makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]");
    });

    const result = await runAgentLoop({
      task: "read a file",
      repoPath,
      maxIterations: 100, // far above any tier cap
      taskClassification: makeClassification("simple"), // iterCap=15
    });

    // Loop should end at iterCap=15, not go to 100
    expect(result.toolCallLog.length).toBeLessThanOrEqual(TIER_LIMITS.simple.iterCap + 2);
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

    expect(result.terminationReason).toBe("max_iterations");
    // Subagent should respect its own override (3), not be raised to any tier cap
    expect(result.toolCallLog.length).toBeLessThanOrEqual(5);
  });
});
