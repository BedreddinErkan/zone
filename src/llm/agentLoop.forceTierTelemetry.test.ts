/**
 * CHARACTERIZATION TEST — pins behaviour that is KNOWN TO BE WRONG.
 *
 * Covers ledger items 328 and 329. Read those entries before changing anything here.
 *
 * `--force-tier` genuinely takes effect: it reaches `resolveTierLimits(..., {forceTierOverride})`,
 * which returns early with the forced tier's limits, so the token cap and iteration ceiling really
 * do change. What it never does is reach the telemetry:
 *
 *   - item 328 — all six `recordLLMCall` sites in agentLoop.ts pass
 *     `tier: input.taskClassification?.tier`, the CLASSIFIER's tier. There is no "effective tier"
 *     string anywhere in the tree; the forced value exists only as a TierLimits object. So a run
 *     invoked with `--force-tier complex` on a task the classifier called "simple" logs "simple".
 *   - item 329 — `emitArchetype` hardcodes `userOverride: null`, which is the one field on that
 *     marker designed to record exactly this override.
 *
 * These assertions therefore encode the DEFECT, not the specification. That is deliberate: the
 * mis-record survived precisely because nothing anywhere asserted on it, and an untested defect is
 * one silent edit away from being joined by another. When either fix lands, the corresponding
 * assertion must be UPDATED to the corrected value — never deleted, or the mis-record becomes
 * unobserved again and this file's whole reason for existing is undone.
 *
 * Driven through the mocked-SDK harness, so it costs nothing to run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

/** A classification the forced tier deliberately disagrees with. */
const CLASSIFIED_SIMPLE = {
  tier: "simple" as const,
  confidence: 0.9,
  archetype: "simple_add" as const,
  archetypeConfidence: 0.9,
  fallbackUsed: false,
  classifierCostUsd: 0,
  estimatedIterations: 1,
  estimatedFiles: 1,
};

function textResponse(content: string) {
  return {
    id: "msg-test",
    model: "claude-sonnet-4-6",
    choices: [{ index: 0, message: { role: "assistant", content, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

async function runForcedComplex(): Promise<{ events: Array<Record<string, unknown>> }> {
  const events: Array<Record<string, unknown>> = [];
  mocks.createChatCompletion.mockImplementation(async () => textResponse("Done."));
  await runAgentLoop({
    task: "add a jsdoc comment",
    repoPath: "/tmp",
    runId: "run-force-tier",
    forceTier: "complex",
    taskClassification: CLASSIFIED_SIMPLE,
    onStructuredEvent: (e: unknown) => { events.push(e as Record<string, unknown>); },
  });
  return { events };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  resetToolExecutorMock(toolExecutorMock);
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "ok" });
  toolExecutorMock.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
});

describe("item 328 (characterization) — cost telemetry records the classifier's tier, not the forced one", () => {
  it("iter_cost_update reports tier 'simple' on a run forced to complex", async () => {
    const { events } = await runForcedComplex();
    const costEvent = events.find((e) => e["type"] === "iter_cost_update");

    // Floor: without this, a run that emitted no cost event at all would make the assertion below
    // vacuously unreachable and the pin would silently stop pinning anything.
    expect(costEvent, "no iter_cost_update event emitted — the pin has nothing to observe").toBeDefined();

    // THE DEFECT, PINNED. "complex" is what was asked for; "simple" is what is recorded.
    expect(costEvent!["tier"]).toBe("simple");
    expect(costEvent!["tier"]).not.toBe("complex");
  });
});

describe("item 329 (characterization) — emitArchetype hardcodes userOverride to null", () => {
  it("the [zone-archetype] marker carries userOverride null even when a tier was forced", async () => {
    await runForcedComplex();

    const archetypeCall = mocks.log.mock.calls.find((c) => String(c[0]).includes("zone-archetype"));
    // Floor: same reason as above — a missing marker must fail loudly, not pass quietly.
    expect(archetypeCall, "no [zone-archetype] marker logged — the pin has nothing to observe").toBeDefined();

    const payload = JSON.parse(String(archetypeCall![1])) as Record<string, unknown>;

    // THE DEFECT, PINNED. This field exists to record exactly the override that was supplied.
    expect(payload["userOverride"]).toBeNull();
    // The same marker's own tier field carries the classifier's value, for the same reason as 328.
    expect(payload["tier"]).toBe("simple");
  });
});
