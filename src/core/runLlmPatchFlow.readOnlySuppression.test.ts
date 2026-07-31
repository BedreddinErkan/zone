import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../types/project.js";

/**
 * runLlmPatchFlow.ts:5927 re-classifies the raw task string for the execution
 * phase. When the classifier returns investigation/question — the two
 * archetypes with readOnlyPipeline:true — the run gets a read-only capability
 * filter regardless of the plan the user already approved (diagnosed on run
 * d31ead23: accept_all, mode:"patch", toolSubsetSize 5, nothing written).
 *
 * These tests exercise the suppression guard added at that site. runAgentLoop
 * is mocked in this file's harness (see setupRunLlmPatchFlowMocks below), so
 * agentLoop.ts's own body never runs here — including the
 * [zone-readonly-pipeline-suppressed]/[zone-readonly-suppression-mismatch]
 * telemetry, which moved to agentLoop.ts's runAgentLoopScoped (it needs the
 * assembled system prompt to report the branch that actually fired, which
 * doesn't exist yet at this layer). What IS observable here, and what this
 * file tests, is the two fields this site threads onto the object passed to
 * runAgentLoop: whether capabilityFilter is present, and whether
 * readOnlyPipelineSuppressed is set — the signal the telemetry now reads.
 * The telemetry's own outcome-based assertions live in
 * agentLoop.readOnlySuppressionTelemetry.test.ts, against the real function.
 */

const scanRepoMock = vi.fn();
const detectProjectStructureMock = vi.fn();
const rankRelevantFilesMock = vi.fn();
const readProjectFilesMock = vi.fn();
const planPatchPreviewWithLlmMock = vi.fn();
const runRuntimeVerificationPlanMock = vi.fn();
const runAgentLoopMock = vi.fn();
const classifyTaskMock = vi.fn();

vi.mock("../repo/scanRepo.js", () => ({ scanRepo: scanRepoMock }));
vi.mock("../repo/detectProjectStructure.js", () => ({ detectProjectStructure: detectProjectStructureMock }));
vi.mock("../repo/rankRelevantFiles.js", () => ({ rankRelevantFiles: rankRelevantFilesMock }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: readProjectFilesMock }));
vi.mock("../llm/planPatchPreview.js", () => ({ planPatchPreviewWithLlm: planPatchPreviewWithLlmMock }));
vi.mock("./runRuntimeVerification.js", () => ({ runRuntimeVerificationPlan: runRuntimeVerificationPlanMock }));
vi.mock("../llm/agentLoop.js", () => ({
  runAgentLoop: runAgentLoopMock,
  stripVerificationTag: vi.fn((s: string) => s),
}));
vi.mock("../llm/taskClassifier.js", () => ({
  classifyTask: classifyTaskMock,
  CLASSIFIER_CONFIDENCE_THRESHOLD: 0.5,
}));

function buildRepoFile(path: string, category: RepoFile["category"] = "unknown"): RepoFile {
  return { path, absolutePath: `C:/repo/${path}`, extension: path.split(".").pop() ?? "", category };
}

const REPO_FILES = [buildRepoFile("src/index.ts", "source")];

const APPROVED_PLAN = {
  objective: "Add a helper",
  steps: [
    { title: "Add helper", description: "Add a small helper function.", filesLikely: ["src/utils/foo.ts"] },
  ],
  scopeSummary: "Add a helper",
  riskHints: [],
};

const STEPLESS_PLAN = {
  objective: "Check the build",
  steps: [],
  scopeSummary: "Check the build",
  riskHints: [],
  noChangeReason: "Build already exits 0 — the asserted bug does not reproduce.",
};

/** Same steps:[] shape as STEPLESS_PLAN, but answer-shaped (C6) — the iter
 *  budget must come from ANSWER_ONLY_ITER_BUDGET (8), not
 *  computeWorkerMaxIterations's 0→1 coercion (6), so this needs a genuinely
 *  distinct value to prove the new branch fired rather than coincidentally
 *  matching the old one. */
const ANSWER_ONLY_PLAN = {
  objective: "Explain the marker sink",
  steps: [],
  scopeSummary: "Explain the marker sink",
  riskHints: [],
  answerOnlyReason: "The task is a question; nothing needs to change.",
};

function classification(archetype: "investigation" | "question") {
  return {
    tier: "medium" as const,
    archetype,
    confidence: 0.9,
    archetypeConfidence: 0.9,
    fallbackUsed: false,
  };
}

beforeEach(() => {
  delete process.env["ZONE_FORCE_FLOW"];
  vi.clearAllMocks();
  runRuntimeVerificationPlanMock.mockResolvedValue({
    attempted: false,
    status: "skipped_no_command",
    steps: [],
    summary: "No safe verification command detected.",
  });
  runAgentLoopMock.mockResolvedValue({
    success: true,
    summary: "mock agent loop",
    toolCallLog: [],
    filesModified: [],
    patchValidatedByAgent: false,
    verificationReason: "tests_inconclusive",
    terminationReason: "natural_completion",
    iterCount: 1,
    promotedFromArchetype: null,
    promotionTrigger: null,
    promotedAtIter: null,
  });
  scanRepoMock.mockResolvedValue(REPO_FILES);
  detectProjectStructureMock.mockReturnValue({ notes: ["Node.js"] });
  rankRelevantFilesMock.mockReturnValue([{ ...REPO_FILES[0]!, score: 10 }]);
  readProjectFilesMock.mockResolvedValue({});
  planPatchPreviewWithLlmMock.mockResolvedValue({ patches: [] });
});

afterEach(() => {
  delete process.env["ZONE_FORCE_FLOW"];
});

async function runWith(opts: {
  archetype: "investigation" | "question";
  preGeneratedPlan?: typeof APPROVED_PLAN | typeof STEPLESS_PLAN | typeof ANSWER_ONLY_PLAN;
  runId: string;
}) {
  classifyTaskMock.mockResolvedValue(classification(opts.archetype));
  const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
  await runLlmPatchFlow({
    task: "trace how a tool result reaches the message history",
    repoPath: "/tmp/fake-repo",
    runId: opts.runId,
    onProgress: () => undefined,
    abortSignal: new AbortController().signal,
    userApiKey: "sk-fake",
    provider: "anthropic",
    mode: "patch",
    ...(opts.preGeneratedPlan ? { preGeneratedPlan: opts.preGeneratedPlan } : {}),
  });
  return runAgentLoopMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
}

describe("read-only pipeline suppression when an approved plan justifies writing", () => {
  it("investigation + approved plan with steps → capabilityFilter suppressed, readOnlyPipelineSuppressed threaded", async () => {
    const call = await runWith({ archetype: "investigation", preGeneratedPlan: APPROVED_PLAN, runId: "run-inv-1" });

    expect(call?.capabilityFilter).toBeUndefined();
    expect(call?.readOnlyPipelineSuppressed).toBe(true);
    // Contrast partner to the stepless case below: 1 step and 0 steps both land on
    // WORKER_ITER_FLOOR, so the budget cannot distinguish "one thing to do" from
    // "nothing to do" (computeWorkerMaxIterations coerces 0 via `|| 1`, subagents.ts:46).
    expect(call?.planApproved).toBe(true);
    expect(call?.maxIterations).toBe(6);
  });

  it("question + approved plan with steps → capabilityFilter suppressed, readOnlyPipelineSuppressed threaded", async () => {
    const call = await runWith({ archetype: "question", preGeneratedPlan: APPROVED_PLAN, runId: "run-q-1" });

    expect(call?.capabilityFilter).toBeUndefined();
    expect(call?.readOnlyPipelineSuppressed).toBe(true);
  });

  it("investigation + approved but stepless plan (noChangeReason) → stays read-only, readOnlyPipelineSuppressed not set", async () => {
    const call = await runWith({ archetype: "investigation", preGeneratedPlan: STEPLESS_PLAN, runId: "run-inv-2" });

    expect(call?.capabilityFilter).toBeDefined();
    expect(call?.readOnlyPipelineSuppressed).not.toBe(true);
    // hasApprovedSteps (runLlmPatchFlow.ts:5917) is a local const with no observable
    // value; these two fields are the only places its `false` surfaces. Asserting both
    // is what makes the stepless branch measured rather than read.
    expect(call?.planApproved).toBe(false);
    // 0 steps → WORKER_ITER_FLOOR, not 0: `planStepsCount || 1` (subagents.ts:46) coerces
    // 0 to 1 before the floor applies, so a plan declaring nothing to do still budgets 6.
    expect(call?.maxIterations).toBe(6);
  });

  it("investigation + no approved plan → unchanged, stays read-only, readOnlyPipelineSuppressed not set", async () => {
    const call = await runWith({ archetype: "investigation", runId: "run-inv-3" });

    expect(call?.capabilityFilter).toBeDefined();
    expect(call?.readOnlyPipelineSuppressed).not.toBe(true);
  });

  it("investigation + answer-only plan (answerOnlyReason) → maxIterations comes from ANSWER_ONLY_ITER_BUDGET, not the worker floor", async () => {
    const call = await runWith({ archetype: "investigation", preGeneratedPlan: ANSWER_ONLY_PLAN, runId: "run-inv-4" });

    expect(call?.maxIterations).toBe(8);
  });
});

/**
 * [zone-answer-only-budget-exhausted] (C6) — reuses this file's harness
 * rather than a new one: runAgentLoopMock is already fully controllable here
 * and preGeneratedPlan wiring is already exercised above. log() is not
 * mocked at module level in this file (an unmocked call falls through to
 * real console.log), so these tests spy on console.log locally instead of
 * widening the file's module mocks.
 */
describe("answer-only budget exhaustion marker (C6)", () => {
  function findMarkerCall(logSpy: ReturnType<typeof vi.spyOn>) {
    return logSpy.mock.calls.find((c) => c[0] === "[zone-answer-only-budget-exhausted]");
  }

  it("fires with iterBudget:8 when an answer-only plan's run hits token_budget_exceeded", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAgentLoopMock.mockResolvedValue({
      success: false,
      summary: "",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "tests_inconclusive",
      terminationReason: "token_budget_exceeded",
      iterCount: 8,
      promotedFromArchetype: null,
      promotionTrigger: null,
      promotedAtIter: null,
    });

    await runWith({ archetype: "investigation", preGeneratedPlan: ANSWER_ONLY_PLAN, runId: "run-answer-exhausted" });

    const markerCall = findMarkerCall(logSpy);
    expect(markerCall).toBeDefined();
    expect(JSON.parse(markerCall![1] as string)).toMatchObject({ iterBudget: 8 });

    logSpy.mockRestore();
  });

  it("does not fire when the run terminates via natural_completion", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAgentLoopMock.mockResolvedValue({
      success: true,
      summary: "The build passes; nothing needs to change.",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "tests_inconclusive",
      terminationReason: "natural_completion",
      iterCount: 3,
      promotedFromArchetype: null,
      promotionTrigger: null,
      promotedAtIter: null,
    });

    await runWith({ archetype: "investigation", preGeneratedPlan: ANSWER_ONLY_PLAN, runId: "run-answer-ok" });

    expect(findMarkerCall(logSpy)).toBeUndefined();

    logSpy.mockRestore();
  });

  it("does not fire for a non-answer stepless plan even at token_budget_exceeded — the marker is answer-shape-specific, not a general iter-cap marker", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAgentLoopMock.mockResolvedValue({
      success: false,
      summary: "",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "tests_inconclusive",
      terminationReason: "token_budget_exceeded",
      iterCount: 6,
      promotedFromArchetype: null,
      promotionTrigger: null,
      promotedAtIter: null,
    });

    await runWith({ archetype: "investigation", preGeneratedPlan: STEPLESS_PLAN, runId: "run-stepless-exhausted" });

    expect(findMarkerCall(logSpy)).toBeUndefined();

    logSpy.mockRestore();
  });
});
