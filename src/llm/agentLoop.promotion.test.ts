import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  log: vi.fn(),
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

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-promotion-"));
  mocks.createChatCompletion.mockReset();
  mocks.executeTool.mockReset();
  mocks.withStagingTempFlush.mockReset();
  mocks.log.mockReset();
  mocks.withStagingTempFlush.mockImplementation(async (fn: () => Promise<void>) => fn());
  mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("L5.1b-2 iter_cap promotion trigger", () => {
  it("fires trigger=iter_cap with atIter=5 on the last capped iteration", async () => {
    // Use distinct filePaths so the loop detector (terminate at 5 identical calls) doesn't fire first
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"a.ts"}'))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"b.ts"}'))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"c.ts"}'))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"d.ts"}'))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"e.ts"}'));
    // 6th call (iter=5, after promotion relaxes cap to 15) returns done

    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-promo-iter-cap",
      pipelineApplied: true,
      originalArchetype: "simple_add",
      maxIterationsOverride: 5,
    });

    const promoLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype-promoted]"
    );
    expect(promoLogs.length).toBe(1);
    const payload = JSON.parse(promoLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.trigger).toBe("iter_cap");
    expect(payload.atIter).toBe(5);
    expect(payload.fromArchetype).toBe("simple_add");
    expect(payload.toArchetype).toBe("complex_multi_file");
  });
});

describe("L5.1b-2 rollback_x2 promotion trigger", () => {
  it("fires trigger=rollback_x2 after two APPLY_ROLLED_BACK results at iter>=1", async () => {
    // iter=0: read the file to satisfy the C1 gate for subsequent apply_patch calls
    // iter=1 and iter=2: apply_patch returns APPLY_ROLLED_BACK
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"x.ts"}'))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"x.ts","blocks":[]}', "call_2"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"x.ts","blocks":[]}', "call_3"));
    // 4th call returns done (default)

    mocks.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") {
        return { success: true, output: "APPLY_ROLLED_BACK: test rollback" };
      }
      return { success: true, output: "ok" };
    });

    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-promo-rollback",
      pipelineApplied: true,
      originalArchetype: "simple_add",
    });

    const promoLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype-promoted]"
    );
    expect(promoLogs.length).toBe(1);
    const payload = JSON.parse(promoLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.trigger).toBe("rollback_x2");
    expect(payload.fromArchetype).toBe("simple_add");
  });
});

describe("L5.1b-2 coaching_exhausted promotion trigger", () => {
  it("fires trigger=coaching_exhausted when budget=1 and tool fails on 2nd iter", async () => {
    // apply_patch with no filePath skips the read-first gate; executeTool failure
    // sets failureDetected=true each iteration.
    const patchResp = makeToolCallResponse("apply_patch", '{"blocks":[]}');
    mocks.createChatCompletion
      .mockResolvedValueOnce(patchResp) // iter=0: fail → coaching (selfCorrectionAttempts=1)
      .mockResolvedValueOnce(patchResp); // iter=1: fail → exhausted → promotion
    // 3rd call returns done (default)

    mocks.executeTool.mockResolvedValue({ success: false, output: "test patch error" });

    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-promo-coaching",
      pipelineApplied: true,
      originalArchetype: "simple_add",
      coachingBudgetOverride: 1,
    });

    const promoLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype-promoted]"
    );
    expect(promoLogs.length).toBe(1);
    const payload = JSON.parse(promoLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.trigger).toBe("coaching_exhausted");
    expect(payload.fromArchetype).toBe("simple_add");
  });
});

describe("L5.1b-2 one-shot promotion guarantee", () => {
  it("emits exactly one [zone-archetype-promoted] even when loop continues after promotion", async () => {
    // Use distinct filePaths so the loop detector (terminate at 5 identical calls) doesn't fire first.
    // iter=0..4: tool calls → iter_cap fires at iter=4 (promotion fires, cap relaxes to 15)
    // iter=5..6: more tool calls to verify _isPromotable is now false (no second promotion)
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"a.ts"}')) // iter=0
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"b.ts"}')) // iter=1
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"c.ts"}')) // iter=2
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"d.ts"}')) // iter=3
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"e.ts"}')) // iter=4 → promotion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"f.ts"}')) // iter=5 → no re-promotion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"g.ts"}')); // iter=6
    // iter=7 returns done (default)

    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      pipelineApplied: true,
      originalArchetype: "simple_add",
      maxIterationsOverride: 5,
    });

    const promoLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype-promoted]"
    );
    expect(promoLogs.length).toBe(1);
  });
});

describe("L5.1b-2 happy path (no promotion)", () => {
  it("leaves promotedFrom=null in [zone-archetype] when run completes within cap", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"a.ts"}'))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"b.ts"}'));
    // 3rd call returns done before hitting iter=4 (the cap boundary)

    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-promo-happy",
      pipelineApplied: true,
      originalArchetype: "simple_add",
      maxIterationsOverride: 5,
    });

    const archetypeLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype]"
    );
    expect(archetypeLogs.length).toBe(1);
    const payload = JSON.parse(archetypeLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.promotedFrom).toBeNull();
    expect(payload.promotionTrigger).toBeNull();
    expect(payload.promotedAtIter).toBeNull();

    const promoLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype-promoted]"
    );
    expect(promoLogs.length).toBe(0);
  });
});

describe("L5.1b-2 default env (no pipelineApplied)", () => {
  it("never emits [zone-archetype-promoted] when pipelineApplied is absent", async () => {
    // Simulate conditions that would trigger promotion if pipelineApplied were set:
    // two APPLY_ROLLED_BACK results at iter>=1.
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"x.ts"}'))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"x.ts","blocks":[]}', "c2"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"x.ts","blocks":[]}', "c3"));

    mocks.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") {
        return { success: true, output: "APPLY_ROLLED_BACK: no pipeline" };
      }
      return { success: true, output: "ok" };
    });

    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      // pipelineApplied intentionally absent
    });

    const promoLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype-promoted]"
    );
    expect(promoLogs.length).toBe(0);
  });
});
