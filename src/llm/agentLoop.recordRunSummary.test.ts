/**
 * Phase Y.2.3.obs: verify that recordRunSummary write failures are surfaced
 * via [zone-run-summary-write-failed] instead of silently swallowed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

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
  recordRunSummary: vi.fn(),
  recordRunRetry: vi.fn(),
  getUsage: vi.fn(),
  readDailyUsdCapOverride: vi.fn<() => number | undefined>(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../usage/usageTracker.js", () => ({
  getUsage: mocks.getUsage,
  recordExecution: vi.fn(),
  readRecords: vi.fn(() => []),
  recordRunSummary: mocks.recordRunSummary,
  recordRunRetry: mocks.recordRunRetry,
  getRunCost: vi.fn(() => 0),
  recordRunSummarySync: vi.fn(),
}));

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: mocks.readDailyUsdCapOverride,
  readTierSettings: vi.fn(() => ({})),
  writeTierSettings: vi.fn(),
  writeDailyUsdCapOverride: vi.fn(),
  getTierSettingsPath: vi.fn(() => "/tmp/tier-limits.json"),
}));

import { runAgentLoop } from "./agentLoop.js";
import { withRequestContext } from "./openaiContext.js";

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "done", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-rec-sum-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.recordRunSummary.mockReset();
  mocks.getUsage.mockReset();
  mocks.readDailyUsdCapOverride.mockReset();
  mocks.readDailyUsdCapOverride.mockReturnValue(0); // unlimited
  mocks.getUsage.mockResolvedValue({
    period: "day" as const,
    totalRuns: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    byProvider: {},
    byModel: {},
  });
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
  mocks.recordRunSummary.mockResolvedValue(undefined); // default: success
  mocks.recordRunRetry.mockReset();
  mocks.recordRunRetry.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("Y.2.3.obs — recordRunSummary failure visibility", () => {
  it("logs [zone-run-summary-write-failed] when recordRunSummary rejects", async () => {
    mocks.recordRunSummary.mockRejectedValue(new Error("simulated disk failure"));

    const consoleSpy = vi.spyOn(console, "log");

    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-obs-123",
    });

    const failedCalls = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0] === "[zone-run-summary-write-failed]"
    );
    expect(failedCalls).toHaveLength(1);

    const payload = JSON.parse(String(failedCalls[0][1])) as Record<string, unknown>;
    expect(payload.runId).toBe("test-run-obs-123");
    expect(payload.error).toBe("simulated disk failure");
    expect(typeof payload.ts).toBe("string");

    consoleSpy.mockRestore();
  });
});

describe("item 221 — the recordRunSummary call site passes the run's real provider, not a hardcoded one", () => {
  it("an explicit openai run threads provider:\"openai\" into recordRunSummary", async () => {
    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-provider-openai",
      provider: "openai",
    });

    const call = mocks.recordRunSummary.mock.calls[0]?.[0] as { provider?: string } | undefined;
    expect(call?.provider).toBe("openai");
  });

  it("an explicit anthropic run threads provider:\"anthropic\" — the other direction of the same pin", async () => {
    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-provider-anthropic",
      provider: "anthropic",
    });

    const call = mocks.recordRunSummary.mock.calls[0]?.[0] as { provider?: string } | undefined;
    expect(call?.provider).toBe("anthropic");
  });

  it("omitting provider (and no request context) falls back to the anthropic literal — the ?? \"anthropic\" default arm itself, not just pass-through", async () => {
    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-provider-omitted",
    });

    const call = mocks.recordRunSummary.mock.calls[0]?.[0] as { provider?: string } | undefined;
    expect(call?.provider).toBe("anthropic");
  });
});

describe("agentLoop.ts:3564 — the retry-event provider fallback (gateway-support-investigation.md §2.4 site 5; characterization, not endorsement)", () => {
  // zone_llm_retry_started only ever fires from inside withExponentialBackoff, beneath a REAL
  // adapter's REAL SDK call throwing a retryable error class. Reaching that here would mean
  // abandoning this file's own established convention of replacing createLLMClient with a bare
  // fake client. Instead, the fake client's own createChatCompletion invokes the onRetryEvent
  // callback runAgentLoop hands it through options — the exact seam a real client would also
  // receive it through — so the real, unmocked onRetryEvent closure inside agentLoop.ts runs for
  // real and calls the real recordRunRetry. No real SDK error class and no fake-timer handling of
  // withExponentialBackoff's own backoff delays are needed: the event is synthesized at the
  // client seam, not earned by driving a real retry loop. This pins the handler's own fallback
  // arm only — no test in this repo establishes that zone_llm_retry_started actually fires from
  // withExponentialBackoff under a real retryable SDK error; that reachability question is
  // untested.

  it("omitting provider (and no request context) falls back to the anthropic literal", async () => {
    mocks.createChatCompletion.mockImplementation(
      async (
        _params: unknown,
        options?: { onRetryEvent?: (event: string, payload: Record<string, unknown>) => void }
      ) => {
        options?.onRetryEvent?.("zone_llm_retry_started", {});
        return makeDoneResponse();
      }
    );

    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-retry-fallback",
    });

    const call = mocks.recordRunRetry.mock.calls[0]?.[0] as { provider?: string } | undefined;
    expect(call?.provider).toBe("anthropic");
  });

  it("an explicit openai run threads provider:\"openai\" into recordRunRetry too", async () => {
    mocks.createChatCompletion.mockImplementation(
      async (
        _params: unknown,
        options?: { onRetryEvent?: (event: string, payload: Record<string, unknown>) => void }
      ) => {
        options?.onRetryEvent?.("zone_llm_retry_started", {});
        return makeDoneResponse();
      }
    );

    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-retry-openai",
      provider: "openai",
    });

    const call = mocks.recordRunRetry.mock.calls[0]?.[0] as { provider?: string } | undefined;
    expect(call?.provider).toBe("openai");
  });
});

/**
 * The context rung of the three-arm precedence, which nothing in this file exercised (item 387).
 *
 * `runAgentLoop` builds its own scoped context and never assigns `provider` to it, and no test
 * here wrapped the call in an outer context — so `getRequestContext()?.provider` was `undefined`
 * in all six cases above. That means a resolver call with the `context` argument DROPPED
 * ENTIRELY, or with `context` and `explicit` inverted, passed every one of them. The site's own
 * comment says it must match factory.ts's precedence exactly, so the rung needs a test that can
 * tell the difference.
 */
describe("provider precedence: the request-context rung (item 387)", () => {
  it("with no explicit provider, the request context supplies it — not the anthropic fallback", async () => {
    await withRequestContext({ provider: "openai" }, async () => {
      await runAgentLoop({
        task: "do something",
        repoPath,
        userId: "user-1",
        runId: "test-run-ctx-openai",
      });
    });

    const call = mocks.recordRunSummary.mock.calls[0]?.[0] as { provider?: string } | undefined;
    expect(call?.provider).toBe("openai");
  });

  it("an explicit provider outranks the request context", async () => {
    await withRequestContext({ provider: "openai" }, async () => {
      await runAgentLoop({
        task: "do something",
        repoPath,
        userId: "user-1",
        runId: "test-run-ctx-outranked",
        provider: "anthropic",
      });
    });

    const call = mocks.recordRunSummary.mock.calls[0]?.[0] as { provider?: string } | undefined;
    expect(call?.provider).toBe("anthropic");
  });
});
