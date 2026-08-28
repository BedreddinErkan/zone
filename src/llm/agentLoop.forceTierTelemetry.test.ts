/**
 * Item 328 CLOSED, item 330 CLOSED, item 329 still OPEN — read all three before changing anything
 * here.
 *
 * `--force-tier` (and `ZONE_FORCE_TIER`, which resolves to the same field) now moves the SAME tier
 * every downstream consumer reads. `runAgentLoop` rebinds `input.taskClassification` to a shallow
 * copy with `.tier` overridden, once, before either the tool-subset filter or any telemetry site
 * reads it — see the comment at the top of `runAgentLoop` in `agentLoop.ts`. That fixed:
 *
 *   - item 328 — all six `recordLLMCall` sites read the corrected tier now, so a run invoked with
 *     `--force-tier complex` on a task the classifier called "simple" logs "complex".
 *   - item 330 — `tierToolFilter` reads the corrected tier too, so the tool subset actually widens
 *     to the forced tier instead of staying at whatever the classifier originally said.
 *
 * item 329 is NOT fixed by this and is a genuinely separate defect: `emitArchetype` hardcodes
 * `userOverride: null` as a literal, unrelated to any tier read, and remains open (deferred-work.md
 * item 329, bucket unchanged). Its assertion below is still a CHARACTERIZATION of that one field —
 * update it, never delete it, when item 329 itself is fixed.
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

describe("item 328 (fixed) — cost telemetry now records the forced tier", () => {
  it("iter_cost_update reports tier 'complex' on a run forced to complex", async () => {
    const { events } = await runForcedComplex();
    const costEvent = events.find((e) => e["type"] === "iter_cost_update");

    // Floor: without this, a run that emitted no cost event at all would make the assertion below
    // vacuously unreachable and the pin would silently stop pinning anything.
    expect(costEvent, "no iter_cost_update event emitted — the pin has nothing to observe").toBeDefined();

    // THE FIX, PINNED. "complex" is what was asked for, and now what is recorded.
    expect(costEvent!["tier"]).toBe("complex");
    expect(costEvent!["tier"]).not.toBe("simple");
  });
});

describe("item 330 (fixed) — the tool subset now moves with the forced tier", () => {
  it("a run forced to complex is offered the full tool set, not the simple-tier subset", async () => {
    await runForcedComplex();

    expect(mocks.createChatCompletion).toHaveBeenCalled();
    const [params] = mocks.createChatCompletion.mock.calls[0]!;
    const toolNames = (
      (params as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    ).map((t) => t.function?.name);

    // THE FIX, PINNED. search_in_files is absent from the 5-tool simple-tier subset
    // (apply_patch, multi_edit, read_file, run_command, write_file) and present at every
    // wider tier — its presence here is a direct signal that tierToolFilter read the forced
    // tier, not the classifier's original "simple".
    expect(toolNames).toContain("search_in_files");
  });
});

describe("item 329 (characterization, still open) — emitArchetype hardcodes userOverride to null", () => {
  it("the [zone-archetype] marker carries userOverride null even when a tier was forced", async () => {
    await runForcedComplex();

    const archetypeCall = mocks.log.mock.calls.find((c) => String(c[0]).includes("zone-archetype"));
    // Floor: same reason as above — a missing marker must fail loudly, not pass quietly.
    expect(archetypeCall, "no [zone-archetype] marker logged — the pin has nothing to observe").toBeDefined();

    const payload = JSON.parse(String(archetypeCall![1])) as Record<string, unknown>;

    // THE DEFECT, STILL PINNED — item 329, not part of this fix. This field exists to record
    // exactly the override that was supplied, and still doesn't.
    expect(payload["userOverride"]).toBeNull();
    // The same marker's own tier field is now correct (item 328/330's fix) — it is a different
    // field on the same call than userOverride, and reads input.taskClassification.tier like
    // every other corrected site.
    expect(payload["tier"]).toBe("complex");
  });
});
