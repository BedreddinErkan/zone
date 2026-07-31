/**
 * The answer shape a stepless plan already produces, measured at the two places it
 * actually exists: the assembled system prompt, and the capability set offered
 * alongside it.
 *
 * A stepless plan (steps: [], noChangeReason set) leaves planApproved false
 * (runLlmPatchFlow.ts:5917/:5948), which leaves effectiveArchetype intact
 * (agentLoop.ts:716), which fires the INVESTIGATION GUIDE branch — including the
 * line that asks for a prose answer rather than edits. That much is asserted here
 * against the real assembled string, not against the branch that builds it.
 *
 * The second half is constraint 5: for a stepless plan, scopeGuard enforcement is
 * OFF (scopeGuard.ts:42-44 returns null for zero steps), so read-only-ness rests
 * entirely on the capability filter surviving. Those two facts are only meaningful
 * together, so they are observed in one probe, from one run.
 *
 * R5 CORRECTION (2026-08-01) — READ THIS BEFORE TRUSTING THE CAPABILITY HALF.
 * The capability assertions below exercise buildPipelineConfig /
 * buildDispatcherCapabilityFilter **as builders, against a hand-set archetype**. They do
 * NOT establish that a real run reaches a read-only tool set, because they supply
 * archetype "investigation" and production does not produce that value for this shape:
 * the execution phase re-classifies from task text alone and was measured returning
 * "debug", whose null pipeline config yields no capability filter at all. Mutation 5
 * proved the builders are really called; it could not prove the INPUT matches production
 * — the builders were real, the input was a fixture, one level above a shielded mutation.
 *
 * The production path is covered instead by
 * runLlmPatchFlow.terminationReasonProbe.test.ts's R4 case, which classifies as "debug"
 * and asserts on the tool list actually sent to the API. Keep this file for what it
 * genuinely pins — the prompt branch, and the builders' own behavior — and do not read
 * its tool-set assertions as evidence about the real dispatch path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import { buildPipelineConfig, buildDispatcherCapabilityFilter, readArchetypeFlagsFromEnv } from "./archetypeDispatcher.js";
import { checkWriteScope } from "../tools/scopeGuard.js";
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

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

import { runAgentLoop } from "./agentLoop.js";

type CapturedMessage = { role: string; content: unknown };
type CapturedTool = { function?: { name?: string } };

function makeDoneResponse(text = "Task complete.") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
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

/** Same shape as the stepless fixtures in dispatch.steplessReplan.test.ts and
 *  runLlmPatchFlow.readOnlySuppression.test.ts — this is the third leg of the seam. */
const STEPLESS_PLAN: ExecutionPlan = {
  objective: "Check the build",
  steps: [],
  riskHints: [],
  scopeSummary: "Check the build",
  noChangeReason: "Build already exits 0 — the asserted bug does not reproduce.",
};

/** Same steps:[] shape as STEPLESS_PLAN, but answer-shaped (C5) — scopeGuard now
 *  blocks explicitly for this fixture instead of returning null. */
const ANSWER_ONLY_PLAN: ExecutionPlan = {
  objective: "Explain the marker sink",
  steps: [],
  riskHints: [],
  scopeSummary: "Explain the marker sink",
  answerOnlyReason: "The task is a question; nothing needs to change.",
};

const WRITE_CAPABLE_TOOLS = ["apply_patch", "write_file", "multi_edit"];

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-stepless-answer-shape-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

/**
 * Runs the real agent loop with the capability filter derived the way production
 * derives it (runLlmPatchFlow.ts:5901-5905), not from a hand-written fixture.
 * Mutation 5 (archetypeDispatcher.ts:107) exists to prove this reconstruction
 * tracks production rather than having drifted into a fixture of its own.
 */
async function runStepless(plan: ExecutionPlan = STEPLESS_PLAN): Promise<{ systemText: string; toolNames: string[] }> {
  let messages: CapturedMessage[] = [];
  let tools: CapturedTool[] = [];
  mocks.createChatCompletion.mockImplementationOnce(
    async (params: { messages: CapturedMessage[]; tools?: CapturedTool[] }) => {
      messages = params.messages;
      tools = params.tools ?? [];
      return makeDoneResponse();
    }
  );

  const pipelineCfg = buildPipelineConfig("investigation", readArchetypeFlagsFromEnv());
  const capabilityFilter = buildDispatcherCapabilityFilter(pipelineCfg);

  await runAgentLoop({
    task: "why does the marker sink write where it does",
    repoPath,
    taskClassification: classification("investigation"),
    executionPlan: plan,
    planApproved: false,
    ...(capabilityFilter ? { capabilityFilter } : {}),
    maxIterationsOverride: 3,
  });

  const systemMsg = messages.find((m) => m.role === "system");
  expect(systemMsg).toBeDefined();
  return {
    systemText: String(systemMsg!.content),
    toolNames: tools.map((t) => t.function?.name ?? ""),
  };
}

describe("stepless plan → answer shape survives in the assembled prompt", () => {
  it("the real system prompt asks for a prose answer, not edits", async () => {
    const { systemText } = await runStepless();

    // The literal instruction, not just the INVESTIGATION GUIDE header that
    // agentLoop.readOnlySuppressionTelemetry.test.ts already pins — this is the
    // line that makes the branch an answer shape rather than merely a read-only one.
    expect(systemText).toContain("Final response: prose summary");
  });
});

describe("BUILDERS (forced archetype, NOT the production path — see R5 note at top): stepless plan → scope enforcement off, capability set stands in for it", () => {
  it("checkWriteScope permits every path while the offered tools contain no way to write", async () => {
    const { toolNames } = await runStepless();

    // Positive control FIRST. "Contains no write tool" is vacuously true of an empty
    // or malformed list, so the absence assertions below mean nothing until the list
    // is shown to be a real, populated, read-capable tool set.
    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("search_in_files");

    // Half 1 — enforcement is OFF: zero steps means scopeGuard has no allowlist to
    // check against, so it blocks nothing, for any path.
    expect(checkWriteScope("src/anything.ts", STEPLESS_PLAN)).toBeNull();

    // Half 2 — observed in the same run, from the same request: the only thing
    // actually preventing a write is that no write tool was offered.
    for (const name of WRITE_CAPABLE_TOOLS) {
      expect(toolNames).not.toContain(name);
    }
  });
});

describe("BUILDERS (forced archetype, NOT the production path — see R5 note at top): answer-only plan → scope enforcement is ON, independent of the capability set (C5)", () => {
  it("checkWriteScope blocks every path while the offered tools remain the same read-only set", async () => {
    const { toolNames } = await runStepless(ANSWER_ONLY_PLAN);

    // Positive control FIRST, same reasoning as the noChangeReason case above.
    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("search_in_files");

    // The scopeGuard deny-all for this shape — independent of the capability
    // filter: the tool set offered is the same read-only set as the
    // noChangeReason case, but scopeGuard now blocks explicitly for THIS
    // shape rather than returning null, proving the two are separate layers
    // rather than accidentally coupled through the same steps.length===0 test.
    expect(checkWriteScope("src/anything.ts", ANSWER_ONLY_PLAN)).not.toBeNull();

    for (const name of WRITE_CAPABLE_TOOLS) {
      expect(toolNames).not.toContain(name);
    }
  });
});
