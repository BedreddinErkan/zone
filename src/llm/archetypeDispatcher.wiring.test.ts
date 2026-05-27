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

// callNum makes each patch unique so the loop detector (TERMINATE_THRESHOLD=4) doesn't fire
// before coaching_exhausted fires — 4 identical tool+args hashes would terminate the run first.
function makeApplyPatchResponse(callNum: number = 0) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: `call_ap_${callNum}`,
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              patch: `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -${callNum + 1},1 +${callNum + 1},1 @@\n-old${callNum}\n+new${callNum}\n`,
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "Done.", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-dispatcher-wiring-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("L5.1b-1 excludeToolNames wiring (via capabilityFilter)", () => {
  it("removes Task and suggest_scope_change from the LLM tool list when both excluded", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      capabilityFilter: { excludeToolNames: new Set(["Task", "suggest_scope_change"]) },
    });
    const toolNames = (
      mocks.createChatCompletion.mock.calls[0][0].tools as Array<{
        function: { name: string };
      }>
    ).map((t) => t.function.name);
    expect(toolNames).not.toContain("Task");
    expect(toolNames).not.toContain("suggest_scope_change");
  });

  it("preserves Task and suggest_scope_change in legacy mode (no capabilityFilter)", async () => {
    await runAgentLoop({ task: "add a helper function", repoPath });
    const toolNames = (
      mocks.createChatCompletion.mock.calls[0][0].tools as Array<{
        function: { name: string };
      }>
    ).map((t) => t.function.name);
    expect(toolNames).toContain("Task");
    expect(toolNames).toContain("suggest_scope_change");
  });

  it("does not block read_file or apply_patch when only Task is excluded", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      capabilityFilter: { excludeToolNames: new Set(["Task"]) },
    });
    const toolNames = (
      mocks.createChatCompletion.mock.calls[0][0].tools as Array<{
        function: { name: string };
      }>
    ).map((t) => t.function.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("apply_patch");
    expect(toolNames).not.toContain("Task");
  });
});

describe("L5.1b-1 pipelineApplied telemetry", () => {
  it("emits pipelineApplied=true in [zone-archetype] when pipelineApplied is set", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-wiring-active",
      pipelineApplied: true,
    });
    const archetypeLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype]"
    );
    expect(archetypeLogs.length).toBe(1);
    const payload = JSON.parse(archetypeLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.pipelineApplied).toBe(true);
  });

  it("emits pipelineApplied=false by default (legacy path, no pipelineApplied field)", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-wiring-legacy",
    });
    const archetypeLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype]"
    );
    expect(archetypeLogs.length).toBe(1);
    const payload = JSON.parse(archetypeLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.pipelineApplied).toBe(false);
  });
});

describe("L5.1b-2 promotion telemetry propagation", () => {
  it("records promotedFrom=null in [zone-archetype] when run completes within pipeline cap", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-wiring-promo-null",
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
  });
});

describe("CE.4.1.a: targeted_fix pipeline soft promotion (L5.1b-2)", () => {
  it("emits [zone-archetype-promoted] trigger:iter_cap and records promotedFrom in [zone-archetype]", async () => {
    // The promotion check (agentLoop.ts:3099) runs inside the tool-call processing
    // branch (after inner loop, before [OUTER-LOOP: ITER_TOOLS_PROCESSED] continue).
    // It is NOT reached when the LLM returns a text-only Done response (that path
    // exits via extractResponsesApiOutputText → finalizeRun directly).
    // Setup: first response makes one read_file tool call (routes into tool-call branch),
    // second returns Done. With maxIterationsOverride:1, iter_cap fires at iter 0
    // (0+1 ≥ 1), then the outer loop continues to iter 1 where Done is returned.
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_rc1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ filePath: "src/foo.ts" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValue(makeDoneResponse());

    await runAgentLoop({
      task: "fix bug in src/foo.ts",
      repoPath,
      runId: "test-ce-4-1-a-promo",
      pipelineApplied: true,
      originalArchetype: "targeted_fix",
      maxIterationsOverride: 1,
    });

    const promotedLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype-promoted]"
    );
    expect(promotedLogs.length).toBe(1);
    const promotedPayload = JSON.parse(promotedLogs[0][1] as string) as Record<string, unknown>;
    expect(promotedPayload.trigger).toBe("iter_cap");
    expect(promotedPayload.fromArchetype).toBe("targeted_fix");
    expect(promotedPayload.toArchetype).toBe("complex_multi_file");

    const archetypeLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype]"
    );
    expect(archetypeLogs.length).toBe(1);
    const archetypePayload = JSON.parse(archetypeLogs[0][1] as string) as Record<string, unknown>;
    expect(archetypePayload.promotedFrom).toBe("targeted_fix");
    expect(archetypePayload.promotionTrigger).toBe("iter_cap");
  });
});

describe("CE.4.1.f coaching_exhausted soft promotion (L5.1b-2)", () => {
  it("emits [zone-archetype-promoted] trigger:coaching_exhausted after 4 apply_patch failures with coachingBudgetOverride:3", async () => {
    // 4 non-ROLLED_BACK apply_patch failures (no "APPLY_ROLLED_BACK" prefix → rollbackCount stays 0,
    // rollback_x2 never fires). coachingBudget:3 → attempts 1/2/3 coach, attempt 4 → exhausted.
    // coaching_exhausted fires at iter 3; loop continues to iter 4 where Done is returned.
    toolExecutorMock.executeTool.mockResolvedValue({
      success: false,
      output: "PATCH_SYNTAX_ERROR\nGeneric apply_patch failure for CE.4.1.f test",
    });
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeApplyPatchResponse(0))  // iter 0: coach attempt 1
      .mockResolvedValueOnce(makeApplyPatchResponse(1))  // iter 1: coach attempt 2
      .mockResolvedValueOnce(makeApplyPatchResponse(2))  // iter 2: coach attempt 3
      .mockResolvedValueOnce(makeApplyPatchResponse(3))  // iter 3: exhausted → promotion
      .mockResolvedValue(makeDoneResponse());             // iter 4: Done

    await runAgentLoop({
      task: "fix bug in src/foo.ts",
      repoPath,
      runId: "test-ce-4-1-f-promo",
      pipelineApplied: true,
      originalArchetype: "targeted_fix",
      coachingBudgetOverride: 3,
    });

    const promotedLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype-promoted]"
    );
    expect(promotedLogs.length).toBe(1);
    const promotedPayload = JSON.parse(promotedLogs[0][1] as string) as Record<string, unknown>;
    expect(promotedPayload.trigger).toBe("coaching_exhausted");
    expect(promotedPayload.fromArchetype).toBe("targeted_fix");
    expect(promotedPayload.toArchetype).toBe("complex_multi_file");

    const archetypeLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype]"
    );
    expect(archetypeLogs.length).toBe(1);
    const archetypePayload = JSON.parse(archetypeLogs[0][1] as string) as Record<string, unknown>;
    expect(archetypePayload.promotedFrom).toBe("targeted_fix");
    expect(archetypePayload.promotionTrigger).toBe("coaching_exhausted");
  });
});
