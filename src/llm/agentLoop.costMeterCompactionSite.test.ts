/**
 * Item 254/255's fourth unfed site, closing the one real gap found while mutation-testing the
 * other three: silencing the compaction call site's `budget.recordLLMCall` was caught ONLY by
 * the structural enumeration test (agentLoopCostMeterCoverage.test.ts), not by any behavioural
 * test — confirmed by actually running that mutation across the whole `src/llm/` suite (2527
 * tests, only the 2 structural ones failed). `summarizer.test.ts` covers the real extraction and
 * `compaction.test.ts` covers `ContextCompactor`'s own threading, but neither drives
 * `agentLoop.ts`'s OWN consumption of `CompactionResult.rawUsage` — real compaction needs ~400KB
 * of synthesized context to trigger through a live loop, disproportionate to what this specific
 * gap needs. Instead: mock `ContextCompactor` itself (constructed once via `new` inside
 * agentLoop.ts, so the module is mockable the same way `factory.js`/`toolExecutor.js` already
 * are here) to return a controlled `compacted: true` result on the first iteration, isolating
 * agentLoop.ts's own wiring from whether real compaction logic fires.
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
  checkAndMaybeCompact: vi.fn(),
  contextCompactorCtor: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("./compaction/ContextCompactor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compaction/ContextCompactor.js")>();
  return { ...actual, ContextCompactor: mocks.contextCompactorCtor };
});

import { runAgentLoop } from "./agentLoop.js";

function makeReadFileCall(id: string, filePath: string) {
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
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function makeDoneResponse(text: string) {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-cost-meter-compaction-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.checkAndMaybeCompact.mockReset();
  // mockReset: true (vitest.config.ts) wipes mockImplementation on EVERY vi.fn() before each
  // test, including the constructor captured by vi.mock's factory at module-load time — it must
  // be re-established here, not just at the top of the file. Same class of bug this repo's own
  // toolExecutor mock fixture already names.
  mocks.contextCompactorCtor.mockReset().mockImplementation(() => ({
    checkAndMaybeCompact: mocks.checkAndMaybeCompact,
    getCompactionCount: () => 1,
  }));
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "file content" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("agentLoop.ts's own consumption of CompactionResult.rawUsage (agentLoop.ts:~5225)", () => {
  it("costUsd includes the compaction call's usage when ContextCompactor reports compacted:true", async () => {
    const compactionUsage = { prompt_tokens: 4_000, completion_tokens: 300, total_tokens: 4_300 };
    let compactCalls = 0;
    mocks.checkAndMaybeCompact.mockImplementation(async (args: { responseInput: unknown[] }) => {
      compactCalls += 1;
      if (compactCalls === 1) {
        return {
          compacted: true,
          reason: "compacted",
          newResponseInput: args.responseInput, // no-op rewrite — this test isolates cost wiring
          rawUsage: compactionUsage,
          // Must match the mocked client's own provider ("openai") — pricing an
          // Anthropic model id under the OpenAI provider silently returns 0
          // ([zone-pricing] unknown model), which is what this test's first failed
          // attempt actually hit: not a source defect, a fixture/provider mismatch.
          model: "gpt-4o",
        };
      }
      return { compacted: false, reason: "under_threshold" };
    });

    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeReadFileCall("tc-1", "src/a.ts");
      return makeDoneResponse("done");
    });

    const result = await runAgentLoop({
      task: "read a file",
      repoPath,
      runId: "test-compaction-cost",
      taskClassification: {
        tier: "simple", estimatedFiles: 1, estimatedIterations: 1, confidence: 0.9,
        classifierCostUsd: 0, classifierLatencyMs: 0, classifierModel: "test",
      },
    });

    expect(compactCalls).toBeGreaterThanOrEqual(1);
    const mainCallsCost = (2 * 100 / 1_000_000) * 2.5 + (2 * 50 / 1_000_000) * 10; // 2 real LLM calls, gpt-4o rates
    const compactionFloor = (4_000 / 1_000_000) * 2.5 + (300 / 1_000_000) * 10; // priced at gpt-4o rates too (mock provider is openai)
    // If the compaction call were unfed (the pre-fix defect), costUsd would stop at ~mainCallsCost.
    expect(result.costUsd).toBeGreaterThanOrEqual(mainCallsCost + compactionFloor - 0.0001);
  });

  it("costUsd is unaffected when ContextCompactor never compacts (compacted: false)", async () => {
    mocks.checkAndMaybeCompact.mockResolvedValue({ compacted: false, reason: "under_threshold" });
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeReadFileCall("tc-1", "src/a.ts");
      return makeDoneResponse("done");
    });

    const result = await runAgentLoop({
      task: "read a file",
      repoPath,
      runId: "test-compaction-skip",
      taskClassification: {
        tier: "simple", estimatedFiles: 1, estimatedIterations: 1, confidence: 0.9,
        classifierCostUsd: 0, classifierLatencyMs: 0, classifierModel: "test",
      },
    });

    const mainCallsCost = (2 * 100 / 1_000_000) * 2.5 + (2 * 50 / 1_000_000) * 10;
    expect(result.costUsd).toBeCloseTo(mainCallsCost, 6); // no extra contribution from compaction
  });
});
