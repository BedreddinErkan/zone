/**
 * Positive control for the [zone-web-search] counter.
 *
 * Why this file exists, stated plainly because the gap it closes was invisible for two passes:
 * `webSearchRequests: 0` across every recorded run is the evidence base for the conclusion that
 * Zone's provider-native web search goes unused (docs/deferred-work.md items 273 and 274). That
 * conclusion rests on a chain of five links, and three of them already had non-zero tests —
 * convertResponse/convertStream extract `web_search_requests` from provider usage, usageTracker
 * re-extracts it, and pricing turns it into a fee. The two links that were NOT covered are the two
 * that actually produce the recorded number: agentLoop's `webSearchRequestsTotal +=` accumulator,
 * and its emission into the marker payload. runCompletion/parity.test.ts asserts that
 * `emit.webSearchSummary` is CALLED, but through a `vi.fn()` mock — the real closure never runs, so
 * no payload value was ever asserted anywhere.
 *
 * An always-zero counter and a correctly-zero counter are indistinguishable in the sink. These
 * three cases separate them, and each pins a property a conclusion actually depends on:
 *
 *  1. NON-ZERO — the counter can report a real count at all.
 *  2. ZERO-EMITS — the marker fires even at zero. This is the load-bearing one: the emitter's own
 *     comment says it is unconditional "so dashboards show 'ran, $0' not silence", and nothing
 *     pinned that. If a future change made zero silent, every "0 searches" record would become
 *     indistinguishable from "no record at all" and the evidence base for both ledger entries would
 *     evaporate without a single test failing.
 *  3. SUMMATION — the total accumulates across iterations. A single-iteration test cannot tell `+=`
 *     from `=`, and a per-run total is the counter's entire purpose.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

// ── hoisted mocks ────────────────────────────────────────────────────────────
// Raw vi.fn() inline, never buildToolExecutorMock() — the fixture's own ESM temporal-dead-zone
// constraint (see src/test/fixtures/toolExecutorMock.ts).

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
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, log: mocks.log };
});

import { runAgentLoop } from "./agentLoop.js";

/** `web_search_requests` is a FLAT field on usage — the adapter chain forwards it out of
 *  Anthropic's nested `usage.server_tool_use` before agentLoop reads it. Passing it flat here
 *  mirrors what the adapter hands the loop, which is the contract under test. */
function makeToolCallResponse(id: string, webSearchRequests?: number) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ filePath: "src/foo.ts", lineRange: null }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      ...(webSearchRequests !== undefined ? { web_search_requests: webSearchRequests } : {}),
    },
  };
}

function makeDoneResponse(webSearchRequests?: number) {
  return {
    choices: [
      {
        message: { content: "[ZONE_VERIFICATION: tests_skipped_no_infra]", tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 20,
      total_tokens: 70,
      ...(webSearchRequests !== undefined ? { web_search_requests: webSearchRequests } : {}),
    },
  };
}

function webSearchPayloads(): Array<Record<string, unknown>> {
  return mocks.log.mock.calls
    .filter((c: unknown[]) => c[0] === "[zone-web-search]")
    .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-websearch-counter-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "file content" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("[zone-web-search] counter — positive control", () => {
  it("reports a non-zero count in the marker payload", async () => {
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse(2));

    await runAgentLoop({
      task: "look something up",
      repoPath,
      runId: "websearch-nonzero",
      maxIterationsOverride: 3,
    });

    const payloads = webSearchPayloads();
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    const p = payloads[payloads.length - 1]!;
    expect(p.event).toBe("web_search_run_summary");
    expect(p.runId).toBe("websearch-nonzero");
    expect(p.webSearchRequests).toBe(2);
  });

  it("prices a non-zero count into feeUsd rather than leaving it at zero", async () => {
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse(2));

    await runAgentLoop({
      task: "look something up",
      repoPath,
      runId: "websearch-fee",
      maxIterationsOverride: 3,
    });

    const p = webSearchPayloads().at(-1)!;
    expect(p.feeUsd).toBe(0.02);
  });

  it("accumulates across iterations — two calls of 1 each report 2, not 1", async () => {
    // The case that separates `+=` from `=`. A single-iteration test passes under both.
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeToolCallResponse("tc-1", 1);
      return makeDoneResponse(1);
    });

    await runAgentLoop({
      task: "look two things up",
      repoPath,
      runId: "websearch-sum",
      maxIterationsOverride: 5,
    });

    expect(callCount).toBeGreaterThanOrEqual(2); // the harness really did run two iterations
    const p = webSearchPayloads().at(-1)!;
    expect(p.webSearchRequests).toBe(2);
  });

  it("EMITS AT ZERO — a run with no searches still produces a record, not silence", async () => {
    // The property both ledger conclusions rest on. Without this, an always-silent counter and a
    // genuinely-zero one look identical in the sink, and "0 searches across 82 runs" would be
    // unfalsifiable rather than measured.
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse(undefined));

    await runAgentLoop({
      task: "a task needing nothing external",
      repoPath,
      runId: "websearch-zero",
      maxIterationsOverride: 3,
    });

    const payloads = webSearchPayloads();
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    const p = payloads[payloads.length - 1]!;
    expect(p.runId).toBe("websearch-zero");
    expect(p.webSearchRequests).toBe(0);
    expect(p.feeUsd).toBe(0);
  });
});
