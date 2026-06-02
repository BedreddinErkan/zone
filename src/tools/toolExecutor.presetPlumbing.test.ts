/**
 * U.2.B Commit 4: model-override plumbing through worker dispatch.
 *
 * Worker should inherit the parent's modelOverride.standard when set
 * (explicit override), falling back to getModelForRole default (no override).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  getRequestContext: vi.fn(),
  withRequestContext: vi.fn(),
  getModelForRole: vi.fn(),
  incrementSubagentCallCount: vi.fn(),
  getSubagentCallCount: vi.fn(),
  formatSubagentToolResultForParent: vi.fn(),
  formatExploreSubagentToolResultForParent: vi.fn(),
  subagentTypeAllowedTools: vi.fn(),
  subagentTypeMaxIterations: vi.fn(),
}));

vi.mock("../llm/agentLoop.js", () => ({
  runAgentLoop: mocks.runAgentLoop,
}));

vi.mock("../llm/openaiContext.js", () => ({
  getRequestContext: mocks.getRequestContext,
  withRequestContext: mocks.withRequestContext,
}));

vi.mock("../llm/modelRouting.js", () => ({
  getModelForRole: mocks.getModelForRole,
}));

vi.mock("../llm/subagents.js", () => ({
  incrementSubagentCallCount: mocks.incrementSubagentCallCount,
  getSubagentCallCount: mocks.getSubagentCallCount,
  formatSubagentToolResultForParent: mocks.formatSubagentToolResultForParent,
  formatExploreSubagentToolResultForParent:
    mocks.formatExploreSubagentToolResultForParent,
  subagentTypeAllowedTools: mocks.subagentTypeAllowedTools,
  subagentTypeMaxIterations: mocks.subagentTypeMaxIterations,
  MAX_SUBAGENT_CALLS_PER_PARENT_RUN: 10,
  VALID_SUBAGENT_TYPES: ["worker", "explore"],
}));

import { executeTool } from "./toolExecutor.js";

const REPO_PATH = "/tmp/repo";
const PARENT_RUN_ID = "parent-override-test";

function makeSubagentResult() {
  return {
    success: true,
    summary: "done",
    output: JSON.stringify({ status: "completed", summary: "done" }),
    toolCallCount: 1,
    iterCount: 1,
    tokenUsage: { totalTokens: 100, promptTokens: 80, completionTokens: 20 },
    subagentTokenUsage: { worker: { totalTokens: 0 } },
    verificationStatus: "unverified" as const,
    fileChanges: [],
    runId: PARENT_RUN_ID,
  };
}

beforeEach(() => {
  mocks.runAgentLoop.mockReset();
  mocks.getRequestContext.mockReset();
  mocks.withRequestContext.mockReset();
  mocks.getModelForRole.mockReset();
  mocks.incrementSubagentCallCount.mockReset();
  mocks.getSubagentCallCount.mockReset();
  mocks.formatSubagentToolResultForParent.mockReset();
  mocks.formatExploreSubagentToolResultForParent.mockReset();
  mocks.subagentTypeAllowedTools.mockReset();
  mocks.subagentTypeMaxIterations.mockReset();

  mocks.getSubagentCallCount.mockReturnValue(0);
  mocks.subagentTypeAllowedTools.mockReturnValue(undefined);
  mocks.subagentTypeMaxIterations.mockReturnValue(10);
  mocks.runAgentLoop.mockResolvedValue(makeSubagentResult());
  mocks.formatSubagentToolResultForParent.mockReturnValue({
    success: true,
    output: JSON.stringify({ status: "completed", summary: "done" }),
  });

  mocks.withRequestContext.mockImplementation(
    async (_patch: unknown, fn: () => Promise<unknown>) => fn()
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("U.2.B — model-override plumbing through worker dispatch", () => {
  it("explicit sonnet override: parent modelOverride.standard=sonnet → worker gets Sonnet 4.6", async () => {
    mocks.getRequestContext.mockReturnValue({
      provider: "anthropic",
      modelOverride: { high: "claude-sonnet-4-6", standard: "claude-sonnet-4-6" },
    });
    // getModelForRole should NOT be called since parent.standard is set
    mocks.getModelForRole.mockReturnValue("claude-haiku-4-5");

    await executeTool(
      "Task",
      { subagent_type: "worker", description: "Do work." },
      REPO_PATH,
      undefined,
      { runId: PARENT_RUN_ID }
    );

    const [contextPatch] = mocks.withRequestContext.mock.calls[0] as [
      { modelOverride?: { high?: string; standard?: string } },
      unknown,
    ];
    expect(contextPatch.modelOverride).toEqual({
      high: "claude-sonnet-4-6",
      standard: "claude-sonnet-4-6",
    });
    // getModelForRole was not needed — parent standard took precedence
    expect(mocks.getModelForRole).not.toHaveBeenCalledWith("worker", "anthropic");
  });

  it("no override: no parent modelOverride → worker falls back to getModelForRole (Haiku 4.5)", async () => {
    mocks.getRequestContext.mockReturnValue({ provider: "anthropic" });
    mocks.getModelForRole.mockReturnValue("claude-haiku-4-5");

    await executeTool(
      "Task",
      { subagent_type: "worker", description: "Do work." },
      REPO_PATH,
      undefined,
      { runId: PARENT_RUN_ID }
    );

    expect(mocks.getModelForRole).toHaveBeenCalledWith("worker", "anthropic");
    const [contextPatch] = mocks.withRequestContext.mock.calls[0] as [
      { modelOverride?: { high?: string; standard?: string } },
      unknown,
    ];
    expect(contextPatch.modelOverride).toEqual({
      high: "claude-haiku-4-5",
      standard: "claude-haiku-4-5",
    });
  });

  it("explicit haiku override: parent modelOverride.standard=haiku → worker gets Haiku (same as default but explicit)", async () => {
    mocks.getRequestContext.mockReturnValue({
      provider: "anthropic",
      modelOverride: { high: "claude-haiku-4-5", standard: "claude-haiku-4-5" },
    });

    await executeTool(
      "Task",
      { subagent_type: "worker", description: "Do work." },
      REPO_PATH,
      undefined,
      { runId: PARENT_RUN_ID }
    );

    const [contextPatch] = mocks.withRequestContext.mock.calls[0] as [
      { modelOverride?: { high?: string; standard?: string } },
      unknown,
    ];
    expect(contextPatch.modelOverride).toEqual({
      high: "claude-haiku-4-5",
      standard: "claude-haiku-4-5",
    });
    // Parent standard was used, getModelForRole not called for worker
    expect(mocks.getModelForRole).not.toHaveBeenCalledWith("worker", "anthropic");
  });

  it("[zone-subagent-dispatched] workerModel reflects the explicit worker model override", async () => {
    mocks.getRequestContext.mockReturnValue({
      provider: "anthropic",
      modelOverride: { high: "claude-sonnet-4-6", standard: "claude-sonnet-4-6" },
    });

    await executeTool(
      "Task",
      { subagent_type: "worker", description: "Do work." },
      REPO_PATH,
      undefined,
      { runId: PARENT_RUN_ID }
    );

    // The [zone-subagent-dispatched] is emitted by agentLoop.ts, not toolExecutor
    // We verify via the context patch that workerModel=sonnet is what gets injected
    const [contextPatch] = mocks.withRequestContext.mock.calls[0] as [
      { modelOverride?: { high?: string; standard?: string } },
      unknown,
    ];
    expect(contextPatch.modelOverride?.high).toBe("claude-sonnet-4-6");
  });
});
