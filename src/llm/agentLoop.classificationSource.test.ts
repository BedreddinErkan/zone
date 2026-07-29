import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

/**
 * [zone-tier-constraints-applied] reports tier:"medium", classificationConfidence:0,
 * fallbackUsed:false on the plan-investigation path — runPlanInvestigation calls
 * runAgentLoop with no taskClassification at all, so resolveTierLimits(undefined)
 * falls to "medium" as a literal default, not a decision. The three fields
 * independently ??-default at the call site, so the record reads exactly like a
 * real classification result unless the reader already knows buildFallback always
 * sets fallbackUsed:true for a genuine confidence-0 classification.
 * classificationSource names which case actually happened.
 */

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

function doneResponse() {
  return {
    choices: [{ message: { content: "Done.", tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function events(): Array<Record<string, unknown>> {
  return mocks.log.mock.calls
    .filter((c: unknown[]) => c[0] === "[zone-tier-constraints-applied]")
    .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-classification-source-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  mocks.createChatCompletion.mockResolvedValue(doneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("[zone-tier-constraints-applied] classificationSource", () => {
  it("reports 'absent' when no taskClassification is passed (the plan-investigation shape)", async () => {
    await runAgentLoop({
      task: "read-only investigation with no classifier call",
      repoPath,
      runId: "test-classification-absent",
      // taskClassification intentionally omitted — matches runPlanInvestigation's own call.
    });

    const [evt] = events();
    expect(evt).toBeDefined();
    expect(evt.classificationSource).toBe("absent");
    expect(evt.tier).toBe("medium");
    expect(evt.classificationConfidence).toBe(0);
    expect(evt.fallbackUsed).toBe(false);
  });

  it("reports 'classifier' when a real classification is passed", async () => {
    await runAgentLoop({
      task: "fix the off-by-one",
      repoPath,
      runId: "test-classification-present",
      taskClassification: {
        tier: "medium",
        estimatedFiles: 4,
        estimatedIterations: 12,
        confidence: 0.82,
        reasoning: "small, well-scoped fix",
        archetype: "targeted_fix",
        archetypeConfidence: 0.75,
        classifierCostUsd: 0.002,
        classifierLatencyMs: 1800,
        classifierModel: "claude-haiku-4-5",
        fallbackUsed: false,
      },
    });

    const [evt] = events();
    expect(evt).toBeDefined();
    expect(evt.classificationSource).toBe("classifier");
  });
});
