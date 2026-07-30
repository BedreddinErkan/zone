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
});
