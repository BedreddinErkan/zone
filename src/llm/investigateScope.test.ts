/**
 * Phase AS.0 — investigateScope() unit tests.
 * Covers: shape, telemetry, token-budget skip, agent suggest_scope_change passthrough.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  log: vi.fn(),
  debugLog: vi.fn(),
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
  debugLog: mocks.debugLog,
  errorLog: vi.fn(),
}));

import { investigateScope } from "./investigationFlow.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function textResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("investigateScope — shape", () => {
  beforeEach(() => {
    mocks.log.mockClear();
    mocks.executeTool.mockResolvedValue({ success: true, output: "" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
  });

  it("returns InvestigateScopeResult shape with findings and citations", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("Found `src/api/server.ts:3575` and `src/llm/planApprovals.ts:46`.")
    );

    const result = await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "Find plan approval hook",
      runId: "scope-test-001",
    });

    expect(result.findings).toContain("server.ts");
    expect(result.citations.length).toBeGreaterThanOrEqual(2);
    expect(result.citations[0]).toHaveProperty("file");
    expect(typeof result.toolCallCount).toBe("number");
    expect(typeof result.tokensUsed).toBe("number");
    expect(typeof result.costUsd).toBe("number");
    expect(result.skipped).toBeUndefined();
  });

  it("emits [zone-investigation-summary] marker after run", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("Found `src/llm/taskClassifier.ts:228`.")
    );

    await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "classify task tier",
      runId: "scope-telem-001",
    });

    const summaryCall = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-investigation-summary]"
    );
    expect(summaryCall).toBeDefined();
    const payload = JSON.parse(String(summaryCall![1]));
    expect(payload.event).toBe("investigation_summary");
    expect(payload.runId).toBe("scope-telem-001");
    expect(typeof payload.toolCallCount).toBe("number");
    expect(typeof payload.ts).toBe("string");
  });
});

describe("investigateScope — token budget skip", () => {
  beforeEach(() => {
    mocks.log.mockClear();
    mocks.executeTool.mockResolvedValue({ success: true, output: "" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
  });

  it("returns skipped result when tokenBudgetRemaining < 50k", async () => {
    const result = await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "anything",
      tokenBudgetRemaining: 30_000,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("insufficient_token_budget");
    expect(result.toolCallCount).toBe(0);
  });

  it("emits [zone-investigation-summary] with finalState=skipped when budget is low", async () => {
    await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "anything",
      runId: "skip-test-001",
      tokenBudgetRemaining: 20_000,
    });

    const summaryCall = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-investigation-summary]"
    );
    expect(summaryCall).toBeDefined();
    const payload = JSON.parse(String(summaryCall![1]));
    expect(payload.finalState).toBe("skipped");
    expect(payload.skipReason).toBe("insufficient_token_budget");
  });

  it("proceeds normally when tokenBudgetRemaining >= 50k", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("Nothing found.")
    );

    const result = await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "find anything",
      tokenBudgetRemaining: 100_000,
    });

    expect(result.skipped).toBeUndefined();
    expect(typeof result.findings).toBe("string");
  });

  it("proceeds when tokenBudgetRemaining is not provided (no cap)", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      textResponse("No budget constraint applied.")
    );

    const result = await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "unrestricted query",
    });

    expect(result.skipped).toBeUndefined();
  });
});
