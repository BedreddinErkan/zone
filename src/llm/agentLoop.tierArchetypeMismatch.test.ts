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

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "Done.", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeToolCallResponse(name: string, args: string, id = "call_1") {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ type: "function", id, function: { name, arguments: args } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeClassification(overrides: { archetype?: string; tier?: string } = {}) {
  return {
    tier: (overrides.tier ?? "simple") as import("./taskClassifier.js").TaskTier,
    archetype: (overrides.archetype ?? "targeted_fix") as import("./taskClassifier.js").TaskArchetype,
    archetypeConfidence: 0.8,
    confidence: 0.9,
    estimatedFiles: 2,
    estimatedIterations: 3,
    classifierCostUsd: 0.001,
    classifierLatencyMs: 200,
    classifierModel: "claude-sonnet-4-6",
    fallbackUsed: false,
  };
}

function mismatchLogs(logMock: typeof mocks.log) {
  return logMock.mock.calls.filter((c: unknown[]) => c[0] === "[zone-tier-archetype-mismatch]");
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-tier-mismatch-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// B.1: Tier-archetype mismatch detection + telemetry
// ---------------------------------------------------------------------------

describe("tier-archetype mismatch detection (Phase 6.A Branch B)", () => {
  it("T.1: emits [zone-tier-archetype-mismatch] when forceTier=simple + archetype=targeted_fix", async () => {
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "test-mismatch-1",
      forceTier: "simple",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
    });

    const calls = mismatchLogs(mocks.log);
    expect(calls.length).toBe(1);
    const payload = JSON.parse(calls[0][1] as string) as Record<string, unknown>;
    expect(payload.forcedTier).toBe("simple");
    expect(payload.classifiedArchetype).toBe("targeted_fix");
    expect(payload.archetypeConfidence).toBe(0.8);
    expect(Array.isArray(payload.blockedTools)).toBe(true);
    expect((payload.blockedTools as string[]).length).toBeGreaterThan(0);
    // search_in_files should be blocked
    expect(payload.blockedTools).toContain("search_in_files");
    expect(payload.blockedTools).toContain("find_references");
    // simple-4 tools should NOT be in blockedTools
    expect(payload.blockedTools).not.toContain("read_file");
    expect(payload.blockedTools).not.toContain("apply_patch");
  });

  it("T.2: no emission when forceTier=simple + archetype=simple_add", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-mismatch-2",
      forceTier: "simple",
      taskClassification: makeClassification({ archetype: "simple_add", tier: "simple" }),
    });

    expect(mismatchLogs(mocks.log).length).toBe(0);
  });

  it("T.3: no emission when forceTier is absent (even with exploration archetype)", async () => {
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "test-mismatch-3",
      // no forceTier
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "medium" }),
    });

    expect(mismatchLogs(mocks.log).length).toBe(0);
  });

  it("T.4: no emission when forceTier=medium (only simple triggers mismatch)", async () => {
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "test-mismatch-4",
      forceTier: "medium",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "medium" }),
    });

    expect(mismatchLogs(mocks.log).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B.3: forced_tier_blocking promotion trigger
// ---------------------------------------------------------------------------

describe("forced_tier_blocking promotion trigger (Phase 6.A Branch B)", () => {
  function promotionLogs(logMock: typeof mocks.log) {
    return logMock.mock.calls.filter((c: unknown[]) => c[0] === "[zone-archetype-promoted]");
  }

  it("T.8: emits [zone-archetype-promoted] trigger=forced_tier_blocking when all conditions met", async () => {
    // iter 0-2: read same file 3× (repeat-read threshold)
    // iter 2: apply_patch fails (failureDetected) — iter >= 2 met
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c1"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c2"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c3"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/foo.ts","blocks":[]}', "c4"));
    // 5th call: done (default)

    toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") {
        return { success: false, output: "patch rejected: line mismatch" };
      }
      return { success: true, output: "ok" };
    });

    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "test-forced-promo-1",
      forceTier: "simple",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
    });

    const promoLogs = promotionLogs(mocks.log);
    expect(promoLogs.length).toBe(1);
    const payload = JSON.parse(promoLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.trigger).toBe("forced_tier_blocking");
    expect(payload.toArchetype).toBe("complex_multi_file");
    expect(payload.fromArchetype).toBe("targeted_fix");
  });

  it("T.9: no promotion when archetype=simple_add (not in exploration set)", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c1"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c2"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c3"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/foo.ts","blocks":[]}', "c4"));

    toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") {
        return { success: false, output: "patch rejected" };
      }
      return { success: true, output: "ok" };
    });

    await runAgentLoop({
      task: "add a helper",
      repoPath,
      runId: "test-forced-promo-2",
      forceTier: "simple",
      taskClassification: makeClassification({ archetype: "simple_add", tier: "simple" }),
    });

    const promoLogs = promotionLogs(mocks.log);
    expect(promoLogs.filter((c: unknown[]) => {
      const p = JSON.parse(c[1] as string) as Record<string, unknown>;
      return p.trigger === "forced_tier_blocking";
    }).length).toBe(0);
  });

  it("T.10: promotion fires when file read 2 times (threshold=2)", async () => {
    // Read same file twice (threshold=2), then fail at iter>=2 — should promote
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c1"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c2"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/foo.ts","blocks":[]}', "c3"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/foo.ts","blocks":[]}', "c4"));

    toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") {
        return { success: false, output: "patch rejected" };
      }
      return { success: true, output: "ok" };
    });

    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "test-forced-promo-3",
      forceTier: "simple",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
    });

    const ftbLogs = promotionLogs(mocks.log).filter((c: unknown[]) => {
      const p = JSON.parse(c[1] as string) as Record<string, unknown>;
      return p.trigger === "forced_tier_blocking";
    });
    expect(ftbLogs.length).toBe(1);
  });

  it("T.10b: no promotion when all files read only once (below threshold)", async () => {
    // Read 4 different files once each, then fail — count=1 per file, never >= 2
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/a.ts"}', "c1"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/b.ts"}', "c2"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/c.ts"}', "c3"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/d.ts"}', "c4"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/a.ts","blocks":[]}', "c5"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/a.ts","blocks":[]}', "c6"));

    toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") {
        return { success: false, output: "patch rejected" };
      }
      return { success: true, output: "ok" };
    });

    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "test-forced-promo-3b",
      forceTier: "simple",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
    });

    const ftbLogs = promotionLogs(mocks.log).filter((c: unknown[]) => {
      const p = JSON.parse(c[1] as string) as Record<string, unknown>;
      return p.trigger === "forced_tier_blocking";
    });
    expect(ftbLogs.length).toBe(0);
  });

  it("T.11: one-shot — promotion fires exactly once even when conditions persist", async () => {
    // Read same file 3×, then fail repeatedly — promotion should fire once
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c1"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c2"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c3"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/foo.ts","blocks":[]}', "c4"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/foo.ts","blocks":[]}', "c5"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/foo.ts","blocks":[]}', "c6"));
    // 7th call: done

    toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") {
        return { success: false, output: "patch rejected" };
      }
      return { success: true, output: "ok" };
    });

    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "test-forced-promo-4",
      forceTier: "simple",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
    });

    const ftbLogs = promotionLogs(mocks.log).filter((c: unknown[]) => {
      const p = JSON.parse(c[1] as string) as Record<string, unknown>;
      return p.trigger === "forced_tier_blocking";
    });
    expect(ftbLogs.length).toBe(1);
  });

  it("T.12: iterationBudget NOT relaxed after forced_tier_blocking promotion", async () => {
    // Promotion fires (tool-only) — the loop should still respect tier iter limits,
    // not expand like iter_cap/rollback_x2/coaching_exhausted do.
    // Verify by checking [zone-archetype] finalIter: with simple tier softIterWarn×3 cap,
    // the loop won't run indefinitely after promotion.
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c1"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c2"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c3"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/foo.ts","blocks":[]}', "c4"));

    toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") {
        return { success: false, output: "patch rejected" };
      }
      return { success: true, output: "ok" };
    });

    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "test-forced-promo-5",
      forceTier: "simple",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
    });

    // Confirm promotion fired (tool-only)
    const promoLogs = promotionLogs(mocks.log).filter((c: unknown[]) => {
      const p = JSON.parse(c[1] as string) as Record<string, unknown>;
      return p.trigger === "forced_tier_blocking";
    });
    expect(promoLogs.length).toBe(1);

    // Confirm the archetype log does NOT show a maxIterationsForRun expansion
    // (the loop terminates normally — not because it hit a huge relaxed cap)
    const archetypeLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype]"
    );
    expect(archetypeLogs.length).toBe(1);
    // finalIter should be small (< BASE_MAX_ITERATIONS = 15 default)
    const archetypePayload = JSON.parse(archetypeLogs[0][1] as string) as Record<string, unknown>;
    expect(typeof archetypePayload.finalIter).toBe("number");
    expect(archetypePayload.finalIter as number).toBeLessThan(15);
  });
});
