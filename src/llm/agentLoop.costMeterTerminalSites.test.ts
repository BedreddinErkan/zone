/**
 * Items 254/255: three of agentLoop.ts's five `createChatCompletion` sites made a real, billed
 * call that never fed `budget.recordLLMCall` — the token-budget wrapup, the max-iterations chat
 * answer, and the max-iterations final assessment. Each is exercised here through a real
 * `runAgentLoop` drive (mocked LLM client only), asserting `result.costUsd` includes that site's
 * own call — the mutation target for "silence this one recordLLMCall, only this test dies."
 *
 * Mirrors the established pattern in agentLoop.iterBudget.test.ts / agentLoop.truncation.test.ts.
 * One correction made while building this file, not assumed from the label: the existing
 * `token_budget_exceeded` terminationReason in agentLoop.iterBudget.test.ts's 45-iteration test
 * is the max-iterations exhaustion path under a documented pre-existing naming bug
 * (`runCompletion/composer.ts`'s own "LATENT BUG: max_iterations exit reports
 * 'token_budget_exceeded'" comment) — it does NOT exercise the token-budget-RATIO wrapup this
 * file's first test targets. That site needs the cumulative-token RATIO to cross 0.95, which
 * needs large per-call usage, not many small-usage iterations.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

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

function makeReadFileCall(id: string, filePath: string, usage: Record<string, number>) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ filePath, lineRange: null }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage,
  };
}

function makeDoneResponse(text: string, usage: Record<string, number>) {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage,
  };
}

/** Cost floor from a usage payload alone — a real, independently-computed lower bound the test
 *  asserts against, not a magic constant. gpt-4o rates ($2.50/M in, $10/M out) — the mock
 *  client's own provider is "openai" and no model override is supplied. */
function minCostFor(usage: { prompt_tokens: number; completion_tokens: number }): number {
  return (usage.prompt_tokens / 1_000_000) * 2.5 + (usage.completion_tokens / 1_000_000) * 10;
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-cost-meter-terminal-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "file content" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("token-budget wrapup call (agentLoop.ts:3507) feeds the cost meter", () => {
  it("costUsd includes the wrapup call's own usage, not just the main call's", async () => {
    // One huge-usage tool call pushes cumulativeTokens/tokenBudgetCap past TOKEN_BUDGET_HARD
    // (0.95) for simple tier (cap 400,000) in a single iteration, forcing the ratio check to
    // fire synthesizeTokenBudgetExit — the wrapup call — on the very next loop check.
    const mainUsage = { prompt_tokens: 390_000, completion_tokens: 5_000, total_tokens: 395_000 };
    const wrapupUsage = { prompt_tokens: 50_000, completion_tokens: 2_000, total_tokens: 52_000 };
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeReadFileCall("tc-1", "src/big.ts", mainUsage);
      return makeDoneResponse("Here is what I found before running out of budget.", wrapupUsage);
    });

    const result = await runAgentLoop({
      task: "investigate something large",
      repoPath,
      runId: "test-wrapup-cost",
      taskClassification: {
        tier: "simple", estimatedFiles: 1, estimatedIterations: 1, confidence: 0.9,
        classifierCostUsd: 0, classifierLatencyMs: 0, classifierModel: "test",
      },
    });

    expect(result.terminationReason).toBe("token_budget_exceeded");
    expect(callCount).toBe(2); // main call + the wrapup this fix now records
    const wrapupFloor = minCostFor(wrapupUsage);
    const mainOnlyCost = minCostFor(mainUsage);
    // If the wrapup call were unfed (the pre-fix defect), costUsd would stop at ~mainOnlyCost.
    expect(result.costUsd).toBeGreaterThanOrEqual(mainOnlyCost + wrapupFloor - 0.0001);
  });
});

describe("max-iterations chat-mode answer (agentLoop.ts:5545) feeds the cost meter", () => {
  it("costUsd includes the final chat-answer call's own usage", async () => {
    const iterUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const finalUsage = { prompt_tokens: 5_000, completion_tokens: 500, total_tokens: 5_500 };
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      // Never emits a final text answer within the override — forces max-iterations exhaustion.
      if (callCount <= 2) return makeReadFileCall(`tc-${callCount}`, `src/f${callCount}.ts`, iterUsage);
      return makeDoneResponse("Best answer from what was explored.", finalUsage);
    });

    const result = await runAgentLoop({
      task: "what does this repo do",
      repoPath,
      runId: "test-chat-maxiter-cost",
      mode: "chat",
      maxIterationsOverride: 2,
      taskClassification: {
        tier: "simple", estimatedFiles: 1, estimatedIterations: 1, confidence: 0.9,
        classifierCostUsd: 0, classifierLatencyMs: 0, classifierModel: "test",
        archetype: "question", archetypeConfidence: 1,
      },
    });

    expect(callCount).toBe(3); // 2 iterations + the read-only max-iter chat answer
    const iterFloor = minCostFor(iterUsage) * 2;
    const finalFloor = minCostFor(finalUsage);
    expect(result.costUsd).toBeGreaterThanOrEqual(iterFloor + finalFloor - 0.0001);
  });
});

describe("max-iterations final assessment, write-capable (agentLoop.ts:5653) feeds the cost meter", () => {
  it("costUsd includes the final-assessment call's own usage", async () => {
    const iterUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const finalUsage = { prompt_tokens: 6_000, completion_tokens: 600, total_tokens: 6_600 };
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 2) return makeReadFileCall(`tc-${callCount}`, `src/f${callCount}.ts`, iterUsage);
      return makeDoneResponse("Final summary [ZONE_VERIFICATION: tests_passed]", finalUsage);
    });

    // Default mode ("patch") with a read-only archetype avoids the write-capable
    // verification-tag prompt variant while still routing through the shared final-assessment
    // call site (5653) rather than the chat/investigation one (5545) above.
    const result = await runAgentLoop({
      task: "make a small change",
      repoPath,
      runId: "test-patch-maxiter-cost",
      maxIterationsOverride: 2,
      taskClassification: {
        tier: "simple", estimatedFiles: 1, estimatedIterations: 1, confidence: 0.9,
        classifierCostUsd: 0, classifierLatencyMs: 0, classifierModel: "test",
        archetype: "targeted_fix", archetypeConfidence: 1,
      },
    });

    expect(callCount).toBe(3);
    const iterFloor = minCostFor(iterUsage) * 2;
    const finalFloor = minCostFor(finalUsage);
    expect(result.costUsd).toBeGreaterThanOrEqual(iterFloor + finalFloor - 0.0001);
  });
});
