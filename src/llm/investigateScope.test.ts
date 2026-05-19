/**
 * Phase AS.0 — investigateScope() unit tests.
 * Covers: shape, telemetry, token-budget skip, agent suggest_scope_change passthrough.
 * Phase AS.0.1: parentTier propagated as taskClassification to audit agentLoop.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  log: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock("./agentLoop.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./agentLoop.js")>();
  return {
    ...original,
    runAgentLoop: mocks.runAgentLoop,
  };
});

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: mocks.debugLog,
  errorLog: vi.fn(),
}));

import { investigateScope } from "./investigationFlow.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeLoopResult(summary: string) {
  return {
    summary,
    success: true,
    toolCallLog: [],
    tokenUsage: { total: 150 },
    costUsd: 0.001,
    terminationReason: undefined as string | undefined,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("investigateScope — shape", () => {
  beforeEach(() => {
    mocks.log.mockClear();
    mocks.runAgentLoop.mockClear();
  });

  it("returns InvestigateScopeResult shape with findings and citations", async () => {
    mocks.runAgentLoop.mockResolvedValueOnce(
      makeLoopResult("Found `src/api/server.ts:3575` and `src/llm/planApprovals.ts:46`.")
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
    mocks.runAgentLoop.mockResolvedValueOnce(
      makeLoopResult("Found `src/llm/taskClassifier.ts:228`.")
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
    mocks.runAgentLoop.mockClear();
    mocks.runAgentLoop.mockResolvedValue(makeLoopResult("Nothing found."));
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
    expect(mocks.runAgentLoop).not.toHaveBeenCalled();
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
    const result = await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "find anything",
      tokenBudgetRemaining: 100_000,
    });

    expect(result.skipped).toBeUndefined();
    expect(typeof result.findings).toBe("string");
    expect(mocks.runAgentLoop).toHaveBeenCalledOnce();
  });

  it("proceeds when tokenBudgetRemaining is not provided (no cap)", async () => {
    const result = await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "unrestricted query",
    });

    expect(result.skipped).toBeUndefined();
    expect(mocks.runAgentLoop).toHaveBeenCalledOnce();
  });
});

describe("investigateScope — parentTier propagation", () => {
  beforeEach(() => {
    mocks.log.mockClear();
    mocks.runAgentLoop.mockClear();
    mocks.runAgentLoop.mockResolvedValue(makeLoopResult("Audit findings."));
  });

  it("passes taskClassification with parentTier=complex to agentLoop", async () => {
    await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "audit scope",
      runId: "tier-test-001",
      parentTier: "complex",
    });

    expect(mocks.runAgentLoop).toHaveBeenCalledOnce();
    const callArgs = mocks.runAgentLoop.mock.calls[0][0];
    expect(callArgs.taskClassification).toBeDefined();
    expect(callArgs.taskClassification.tier).toBe("complex");
    expect(callArgs.taskClassification.fallbackUsed).toBe(false);
    expect(callArgs.taskClassification.confidence).toBe(1.0);
  });

  it("passes taskClassification with parentTier=medium to agentLoop", async () => {
    await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "audit scope",
      parentTier: "medium",
    });

    const callArgs = mocks.runAgentLoop.mock.calls[0][0];
    expect(callArgs.taskClassification?.tier).toBe("medium");
    expect(callArgs.taskClassification?.fallbackUsed).toBe(false);
  });

  it("omits taskClassification when parentTier is not provided", async () => {
    await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "audit scope",
    });

    const callArgs = mocks.runAgentLoop.mock.calls[0][0];
    expect(callArgs.taskClassification).toBeUndefined();
  });
});

describe("investigateScope — lane field (Phase O)", () => {
  beforeEach(() => {
    mocks.log.mockClear();
    mocks.runAgentLoop.mockClear();
    mocks.runAgentLoop.mockResolvedValue(makeLoopResult("Audit findings."));
  });

  it("passes lane:'audit' to runAgentLoop so telemetry can distinguish audit vs main", async () => {
    await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "audit scope for lane test",
      runId: "lane-test-001",
    });

    expect(mocks.runAgentLoop).toHaveBeenCalledOnce();
    const callArgs = mocks.runAgentLoop.mock.calls[0][0];
    expect(callArgs.lane).toBe("audit");
  });

  it("emits agent_loop_start with lane:'audit' distinct from main agent lane", async () => {
    const emittedEvents: Array<{ type: string; lane?: string }> = [];
    await investigateScope({
      repoPath: "/tmp/fake-repo",
      query: "audit scope for event lane test",
      runId: "lane-event-001",
      onProgress: (update) => {
        if (update.progress && typeof update.progress === "object") {
          const p = update.progress as Record<string, unknown>;
          emittedEvents.push({ type: String(p["type"] || ""), lane: p["lane"] as string | undefined });
        }
      },
    });

    const startEvent = emittedEvents.find((e) => e.type === "agent_loop_start");
    expect(startEvent).toBeDefined();
    expect(startEvent!.lane).toBe("audit");

    const completeEvent = emittedEvents.find((e) => e.type === "agent_loop_complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.lane).toBe("audit");
  });
});
