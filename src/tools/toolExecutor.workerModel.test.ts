/**
 * U.2.A Commit 2: worker subagent receives Haiku 4.5 model override.
 *
 * When a Task tool dispatches a worker subagent, toolExecutor must inject
 * modelOverride: { high: workerModel, standard: workerModel } into the
 * request context so the worker's LLM calls use the cheaper model.
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
const PARENT_RUN_ID = "parent-run-abc";

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
  mocks.formatExploreSubagentToolResultForParent.mockReturnValue({
    success: true,
    output: JSON.stringify({ status: "completed", summary: "explored" }),
  });

  // withRequestContext: invoke the callback immediately
  mocks.withRequestContext.mockImplementation(
    async (_patch: unknown, fn: () => Promise<unknown>) => fn()
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("U.2.A — worker subagent model injection", () => {
  it("injects claude-haiku-4-5 for worker when provider is anthropic", async () => {
    mocks.getRequestContext.mockReturnValue({ provider: "anthropic" });
    mocks.getModelForRole.mockReturnValue("claude-haiku-4-5");

    await executeTool(
      "Task",
      { subagent_type: "worker", description: "Reason: fix bug\nDo the thing." },
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

  it("injects gpt-5.4-mini for worker when provider is openai", async () => {
    mocks.getRequestContext.mockReturnValue({ provider: "openai" });
    mocks.getModelForRole.mockReturnValue("gpt-5.4-mini");

    await executeTool(
      "Task",
      { subagent_type: "worker", description: "Reason: fix bug\nDo the thing." },
      REPO_PATH,
      undefined,
      { runId: PARENT_RUN_ID }
    );

    expect(mocks.getModelForRole).toHaveBeenCalledWith("worker", "openai");
    const [contextPatch] = mocks.withRequestContext.mock.calls[0] as [
      { modelOverride?: { high?: string; standard?: string } },
      unknown,
    ];
    expect(contextPatch.modelOverride).toEqual({
      high: "gpt-5.4-mini",
      standard: "gpt-5.4-mini",
    });
  });

  it("falls back to openai provider when context has no provider set", async () => {
    mocks.getRequestContext.mockReturnValue({});
    mocks.getModelForRole.mockReturnValue("gpt-5.4-mini");

    await executeTool(
      "Task",
      { subagent_type: "worker", description: "Reason: fix bug\nDo it." },
      REPO_PATH,
      undefined,
      { runId: PARENT_RUN_ID }
    );

    expect(mocks.getModelForRole).toHaveBeenCalledWith("worker", "openai");
  });

  it("does NOT inject modelOverride for explore subagent type", async () => {
    mocks.getRequestContext.mockReturnValue({ provider: "anthropic" });
    mocks.getModelForRole.mockReturnValue("claude-haiku-4-5");

    await executeTool(
      "Task",
      { subagent_type: "explore", description: "Reason: explore\nCheck the repo." },
      REPO_PATH,
      undefined,
      { runId: PARENT_RUN_ID }
    );

    expect(mocks.withRequestContext).toHaveBeenCalled();
    const [contextPatch] = mocks.withRequestContext.mock.calls[0] as [
      { modelOverride?: unknown },
      unknown,
    ];
    expect(contextPatch.modelOverride).toBeUndefined();
  });
});
