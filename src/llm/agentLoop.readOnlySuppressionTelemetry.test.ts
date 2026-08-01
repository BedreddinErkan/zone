/**
 * Read-only suppression telemetry — moved from runLlmPatchFlow.ts's decision site
 * (before the prompt exists) to agentLoop.ts's runAgentLoopScoped (after it's built),
 * so promptBranch reports the branch that actually fired rather than the condition
 * intended to choose it. Every positive assertion here is checked against the real
 * assembled system message captured from the same run, not against the value passed
 * into AgentLoopInput — that's the whole point of moving the emission.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import type { ExecutionPlan } from "./executionPlan.js";
import type { TaskClassification } from "./taskClassifier.js";

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
}));

const mockLog = vi.hoisted(() => vi.fn());

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);
// Partial mock — logger.js also exports debugLog/errorLog/etc., used throughout
// agentLoop.ts's own body; only `log` (what loopTelemetry.ts's emit* functions call)
// needs replacing here.
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, log: mockLog };
});

import { runAgentLoop } from "./agentLoop.js";

type CapturedMessage = { role: string; content: unknown };

function makeDoneResponse(text = "Task complete.") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function markerCalls(name: string): Array<Record<string, unknown>> {
  return mockLog.mock.calls
    .filter((c: unknown[]) => c[0] === name)
    .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

function classification(archetype: "investigation" | "question"): TaskClassification {
  return {
    tier: "medium",
    estimatedFiles: 2,
    estimatedIterations: 5,
    confidence: 0.9,
    classifierCostUsd: 0.002,
    classifierLatencyMs: 1000,
    classifierModel: "claude-haiku-4-5",
    fallbackUsed: false,
    archetype,
    archetypeConfidence: 0.9,
  };
}

const FIXTURE_PLAN: ExecutionPlan = {
  objective: "Add a helper",
  steps: [{ title: "Add helper", description: "Add a small helper function.", filesLikely: ["src/foo.ts"] }],
  riskHints: [],
  scopeSummary: "Add a helper",
};

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-readonly-suppression-telemetry-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mockLog.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("read-only suppression telemetry — outcome, not intent", () => {
  it("consistent state (readOnlyPipelineSuppressed + planApproved agree): promptBranch is 'default', matches the real assembled prompt, no mismatch marker", async () => {
    let messages: CapturedMessage[] = [];
    mocks.createChatCompletion.mockImplementationOnce(async (params: { messages: CapturedMessage[] }) => {
      messages = params.messages;
      return makeDoneResponse();
    });

    await runAgentLoop({
      task: "some task",
      repoPath,
      taskClassification: classification("investigation"),
      executionPlan: FIXTURE_PLAN,
      planApproved: true,
      readOnlyPipelineSuppressed: true,
      maxIterationsOverride: 3,
    });

    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    const systemText = String(systemMsg!.content);

    const [evt] = markerCalls("[zone-readonly-pipeline-suppressed]");
    expect(evt).toBeDefined();
    expect(evt!.promptBranch).toBe("default");
    expect(evt!.archetype).toBe("investigation");
    expect(evt!.stepCount).toBe(1);

    // Cross-check the payload against the REAL assembled prompt, not the value
    // that was passed in — this is the assertion the whole move exists to enable.
    expect(systemText).toContain("BREVITY RULES");
    expect(systemText).not.toContain("INVESTIGATION GUIDE");

    expect(markerCalls("[zone-readonly-suppression-mismatch]")).toHaveLength(0);
  });

  it("invariant-violation state (readOnlyPipelineSuppressed true, planApproved false): promptBranch stays the archetype branch, mismatch marker fires", async () => {
    let messages: CapturedMessage[] = [];
    mocks.createChatCompletion.mockImplementationOnce(async (params: { messages: CapturedMessage[] }) => {
      messages = params.messages;
      return makeDoneResponse();
    });

    // Reachable precisely because readOnlyPipelineSuppressed and planApproved are
    // threaded onto AgentLoopInput separately — nothing enforces that they agree.
    // With planApproved false, effectiveArchetype stays "investigation", so the
    // INVESTIGATION GUIDE branch still fires even though suppression says it
    // shouldn't have needed to (the plan was never actually approved).
    await runAgentLoop({
      task: "some task",
      repoPath,
      taskClassification: classification("investigation"),
      executionPlan: FIXTURE_PLAN,
      planApproved: false,
      readOnlyPipelineSuppressed: true,
      maxIterationsOverride: 3,
    });

    const systemMsg = messages.find((m) => m.role === "system");
    const systemText = String(systemMsg!.content);
    expect(systemText).toContain("INVESTIGATION GUIDE");

    const [evt] = markerCalls("[zone-readonly-pipeline-suppressed]");
    expect(evt!.promptBranch).toBe("investigation");

    const [mismatch] = markerCalls("[zone-readonly-suppression-mismatch]");
    expect(mismatch).toBeDefined();
    expect(mismatch!.promptBranch).toBe("investigation");
  });

  /**
   * [zone-prompt-branch] — the branch decision, reported for EVERY run.
   *
   * The gap this closes: readOnlyPipelineSuppressed requires hasApprovedSteps, which
   * is false for an answer-only plan (steps:[]), so that shape emitted no
   * prompt-branch telemetry at all — which is how it ran three measured passes
   * against a patch contract unnoticed. Deliberately NOT a widening of the
   * suppression gate: its sibling mismatch marker fires on promptBranch !==
   * "default" inside that gate, so widening would make it a false positive on every
   * such run.
   */
  it("fires for a run that never suppressed — the case the suppression gate cannot see", async () => {
    mocks.createChatCompletion.mockImplementationOnce(async () => makeDoneResponse());

    const ANSWER_ONLY_PLAN: ExecutionPlan = {
      objective: "Explain the loop detector",
      steps: [],
      riskHints: [],
      scopeSummary: "Explain the loop detector",
      answerOnlyReason: "Deliberate, documented behavior; nothing to change.",
    };

    await runAgentLoop({
      task: "why does the loop detector fire on 4 identical hashes",
      repoPath,
      // "debug" is production's MEASURED archetype for this shape, not a forced
      // "investigation" — the fixture R5 disqualified.
      taskClassification: { ...classification("investigation"), archetype: "debug" },
      executionPlan: ANSWER_ONLY_PLAN,
      planApproved: false,
      maxIterationsOverride: 3,
    });

    const [evt] = markerCalls("[zone-prompt-branch]");
    expect(evt).toBeDefined();
    expect(evt!.promptBranch).toBe("answer_only");

    // The suppression pair stays silent — this run never suppressed, and the new
    // marker must not have been wired by relaxing their gate.
    expect(markerCalls("[zone-readonly-pipeline-suppressed]")).toHaveLength(0);
  });

  /**
   * The branch is chosen from the approved PLAN's shape, not from a re-classification
   * of the task string. Keyed on archetype "debug" throughout — production's measured
   * value for this shape. A forced "investigation" would be R5's disqualified fixture:
   * it would pass against a branch production never selects.
   */
  it("an answer-only plan gets the answer branch even though the archetype is 'debug'", async () => {
    let messages: CapturedMessage[] = [];
    mocks.createChatCompletion.mockImplementationOnce(async (params: { messages: CapturedMessage[] }) => {
      messages = params.messages;
      return makeDoneResponse();
    });

    await runAgentLoop({
      task: "why does the loop detector fire on 4 identical hashes",
      repoPath,
      taskClassification: { ...classification("investigation"), archetype: "debug" },
      executionPlan: {
        objective: "Explain the loop detector",
        steps: [],
        riskHints: [],
        scopeSummary: "Explain the loop detector",
        answerOnlyReason: "Deliberate, documented behavior; nothing to change.",
      },
      planApproved: false,
      maxIterationsOverride: 3,
    });

    const systemText = String(messages.find((m) => m.role === "system")!.content);
    expect(systemText).toContain("ANSWER MODE (read-only, plan approved)");
    // The two else-arm blocks this shape was measured running against, now absent.
    expect(systemText).not.toContain("BREVITY RULES");
    expect(systemText).not.toContain("EFFICIENCY CONTRACT");
    // NOT asserted, and deliberately so: `PATCH RULES` is appended OUTSIDE the archetype
    // ternary (it follows the ternary's close), so it reaches every branch — the existing
    // question and investigation arms included. Switching the branch cannot remove it, and
    // gating it here would change those two shapes, which this pass does not measure.
    // Recorded as an open item instead.
  });

  /**
   * The output contract, not just the preamble. The baseline run's answer was written
   * against the four-section patch template — it produced "## What changed / (none) — this
   * was an explanatory question" and a [ZONE_VERIFICATION] tag for a run that changed
   * nothing — with the real answer outside the mandated structure the template forbids.
   */
  it("an answer-only run gets the answer contract, and neither patch-summary template nor the verification tag", async () => {
    let messages: CapturedMessage[] = [];
    mocks.createChatCompletion.mockImplementationOnce(async (params: { messages: CapturedMessage[] }) => {
      messages = params.messages;
      return makeDoneResponse();
    });

    await runAgentLoop({
      task: "why does the loop detector fire on 4 identical hashes",
      repoPath,
      taskClassification: { ...classification("investigation"), archetype: "debug" },
      executionPlan: {
        objective: "Explain the loop detector",
        steps: [],
        riskHints: [],
        scopeSummary: "Explain the loop detector",
        answerOnlyReason: "Deliberate, documented behavior; nothing to change.",
      },
      planApproved: false,
      // "detailed" specifically: the answer arm must displace whichever of the two
      // patch templates is selected, not only COMPACT_SUMMARY.
      summaryFormat: "detailed",
      maxIterationsOverride: 3,
    });

    const systemText = String(messages.find((m) => m.role === "system")!.content);
    expect(systemText).toContain("FINAL ANSWER (required");
    // "FINAL SUMMARY (required" heads BOTH patch templates and appears in neither the
    // answer contract nor anywhere else — the discriminator between the two. Not
    // "## What changed": the answer contract names that section in its own FORBIDDEN
    // list, so asserting its absence would match this text against itself.
    expect(systemText).not.toContain("FINAL SUMMARY (required");
    expect(systemText).not.toContain("[ZONE_VERIFICATION: tests_passed]");
  });

  it("CONTRAST: a 'debug' run with a normal stepped plan still gets the patch branch", async () => {
    let messages: CapturedMessage[] = [];
    mocks.createChatCompletion.mockImplementationOnce(async (params: { messages: CapturedMessage[] }) => {
      messages = params.messages;
      return makeDoneResponse();
    });

    // Same archetype, same planApproved — only the plan's shape differs. That is what
    // makes the assertion above about the PLAN rather than about "debug".
    await runAgentLoop({
      task: "fix the thing",
      repoPath,
      taskClassification: { ...classification("investigation"), archetype: "debug" },
      executionPlan: FIXTURE_PLAN,
      planApproved: false,
      maxIterationsOverride: 3,
    });

    const systemText = String(messages.find((m) => m.role === "system")!.content);
    expect(systemText).toContain("BREVITY RULES");
    // The patch contract is untouched for every other shape — the answer arm is additive,
    // not a replacement of the default. Same discriminator as the assertion above.
    expect(systemText).toContain("FINAL SUMMARY (required");
  });
});
