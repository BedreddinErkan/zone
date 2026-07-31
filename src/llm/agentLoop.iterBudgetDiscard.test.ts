/**
 * [zone-iter-budget-discarded] — the instrument for a field that looks like it bounds
 * the run and does not.
 *
 * agentLoop.ts:2292-2296 overwrites maxIterationsForRun with softIterWarn*3 for every
 * main loop, unconditionally within the tierLimits branch, and the restore at
 * :2364-2367 re-applies `maxIterationsOverride` only. So a caller's explicit
 * `maxIterations` is silently discarded. Four call sites supply it today and all four
 * are main loops (runLlmPatchFlow.ts:5959, :9943, :10211, investigationFlow.ts:132).
 *
 * Rather than fix that here — making it bind would move every plan-mode run from ~75
 * iterations to 6-24 with no measurement of real iteration distributions behind it —
 * the discard is made loud, so the eventual general fix can be driven by recorded runs.
 * This file pins that the marker fires with both numbers, and stays silent when there
 * is nothing to discard.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import type { TaskClassification } from "./taskClassifier.js";

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
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

import { runAgentLoop } from "./agentLoop.js";

/** Completes on the first turn — this file measures budget bookkeeping at loop entry,
 *  which happens before any iteration runs, so there is no reason to pay for more. */
function makeDoneResponse() {
  return {
    choices: [{ message: { content: "Task complete.", tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** medium tier ⇒ softIterWarn 25 (tierLimits.ts:26) ⇒ effective bound 75. */
function classification(): TaskClassification {
  return {
    tier: "medium",
    estimatedFiles: 2,
    estimatedIterations: 5,
    confidence: 0.9,
    classifierCostUsd: 0.002,
    classifierLatencyMs: 1000,
    classifierModel: "claude-haiku-4-5",
    fallbackUsed: false,
    archetype: "investigation",
    archetypeConfidence: 0.9,
  };
}

let repoPath: string;
let logSpy: ReturnType<typeof vi.spyOn>;

function discardCalls(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .filter((c: unknown[]) => c[0] === "[zone-iter-budget-discarded]")
    .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-iter-discard-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("[zone-iter-budget-discarded]", () => {
  it("fires with both the supplied and the effective bound when maxIterations is overwritten", async () => {
    await runAgentLoop({
      task: "explain the marker sink",
      repoPath,
      taskClassification: classification(),
      mode: "patch",
      maxIterations: 6,
    });

    const calls = discardCalls();
    expect(calls).toHaveLength(1);
    // 6 asked for, 75 actually enforced — the gap this marker exists to record.
    expect(calls[0]).toMatchObject({
      suppliedMaxIterations: 6,
      effectiveMaxIterations: 75,
      tier: "medium",
    });
  });

  it("stays silent when no explicit maxIterations was supplied — nothing was discarded", async () => {
    await runAgentLoop({
      task: "explain the marker sink",
      repoPath,
      taskClassification: classification(),
      mode: "patch",
    });

    expect(discardCalls()).toHaveLength(0);
  });
});
