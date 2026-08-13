import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The stepless replan arms — the only route by which a plan with `steps: []` can
 * reach the approval gate or execution. dispatch.ts's three normal guarantees of
 * non-empty steps (E8a :367, E8b :384, the forceSteps/synthesizeMinimalPlan safety
 * net :400-416) all run BEFORE the approval loop and none of them re-run on a
 * replan, so `feedback`/`refine` (:488) and `approve_with_feedback` (:525) can each
 * carry a stepless plan forward.
 *
 * [zone-plan-empty-approval] has fired 0 times in ~/.zone/markers.jsonl, so this
 * path has never executed in production. These tests are the first measurement of
 * it. Note what they do and do not establish: emitPlanEmptyApproval is MOCKED here,
 * so these assertions pin the CALL SITE and its payload — not the channel the real
 * emitter uses. The channel (log, not debugLog — planApprovals.ts:8/:44) is
 * established by reading, not by this file.
 *
 * Harness copied from dispatch.planDecisionMarker.test.ts:1-132 rather than
 * reinvented; the only additions are the stepless fixture and the isNoChangePlan
 * return value.
 */

const mockRunLlmPatchFlow = vi.hoisted(() => vi.fn());
const mockRejectPendingApprovalsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingRevisionsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingPlansForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingEditsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingTrustForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRequestPlanApproval = vi.hoisted(() => vi.fn());
const mockEmitPlanEmptyApproval = vi.hoisted(() => vi.fn());
const mockClearTrustedCommandsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockSetTrustAllForRun = vi.hoisted(() => vi.fn());
const mockBuildCliSink = vi.hoisted(() => vi.fn(() => ({ onProgress: vi.fn() })));
const mockCreateSpinner = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const mockPreparePlanContext = vi.hoisted(() => vi.fn());
const mockGenerateExecutionPlan = vi.hoisted(() => vi.fn());
const mockLoadDiskModelSync = vi.hoisted(() => vi.fn(() => null));
const mockRunPlanInvestigation = vi.hoisted(() => vi.fn());
const mockIsNoChangePlan = vi.hoisted(() => vi.fn());
const mockIsCannotVerifyPlan = vi.hoisted(() => vi.fn());
const mockDebugLog = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => vi.fn());

vi.mock("../core/runLlmPatchFlow.js", () => ({ runLlmPatchFlow: mockRunLlmPatchFlow, isChitchat: () => false, isVagueDeveloperTask: () => false }));
vi.mock("../api/commandApprovals.js", () => ({
  rejectPendingApprovalsForRun: mockRejectPendingApprovalsForRun,
  clearTrustedCommandsForRun: mockClearTrustedCommandsForRun,
  setTrustAllForRun: mockSetTrustAllForRun,
}));
vi.mock("../llm/revisionApprovals.js", () => ({
  rejectPendingRevisionsForRun: mockRejectPendingRevisionsForRun,
}));
vi.mock("../llm/planApprovals.js", () => ({
  requestPlanApproval: mockRequestPlanApproval,
  rejectPendingPlansForRun: mockRejectPendingPlansForRun,
  emitPlanEmptyApproval: mockEmitPlanEmptyApproval,
}));
vi.mock("../api/editApprovals.js", () => ({
  rejectPendingEditsForRun: mockRejectPendingEditsForRun,
}));
vi.mock("../api/trustApprovals.js", () => ({
  requestTrustApproval: vi.fn().mockResolvedValue(true),
  rejectPendingTrustForRun: mockRejectPendingTrustForRun,
}));
vi.mock("./sink.js", () => ({
  buildCliSink: mockBuildCliSink,
  createSpinner: mockCreateSpinner,
}));
vi.mock("../core/preparePlanContext.js", () => ({ preparePlanContext: mockPreparePlanContext }));
// Partial mock: dispatch.ts's two emitPlanEmptyApproval sites now call the REAL
// planTerminalShape (a pure classifier) rather than isNoChangePlan/isCannotVerifyPlan
// directly, so it must not be replaced with a stand-in here — a hand-copied second
// implementation could drift from the real one and this file would never notice.
vi.mock("../llm/executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/executionPlan.js")>();
  return {
    planTerminalShape: actual.planTerminalShape,
    // Real predicate (C7): both replan call sites now call isAnswerOnlyPlan
    // unconditionally to build forceSteps — unlike the safety net's call,
    // this one isn't short-circuited by steps.length===0, so every test that
    // reaches either replan arm exercises it, not just the answer-shaped ones.
    isAnswerOnlyPlan: actual.isAnswerOnlyPlan,
    generateExecutionPlan: mockGenerateExecutionPlan,
    isNoChangePlan: mockIsNoChangePlan,
    isCannotVerifyPlan: mockIsCannotVerifyPlan,
    synthesizeMinimalPlan: (task: string) => ({
      objective: task.slice(0, 200),
      steps: [{ title: task.slice(0, 80), description: task, filesLikely: [] }],
      riskHints: [],
      scopeSummary: task.slice(0, 160),
    }),
  };
});
vi.mock("../visual/tierSettings.js", () => ({ readDailyUsdCapOverride: vi.fn() }));
vi.mock("../api/diskModel.js", () => ({ loadDiskModelSync: mockLoadDiskModelSync }));
vi.mock("../llm/planInvestigation.js", () => ({ runPlanInvestigation: mockRunPlanInvestigation }));
vi.mock("../utils/logger.js", () => ({ debugLog: mockDebugLog, log: mockLog }));

import { runOneShotInner } from "./dispatch.js";

const BASE_CONFIG = {
  model: "claude-sonnet-4-6",
  provider: "anthropic" as const,
  anthropicApiKey: "sk-ant-test",
  openaiApiKey: undefined,
  dailyUsdCap: 10,
  repoPath: "/tmp/test-repo",
  forceTier: undefined,
  autoApprove: false,
  noRevision: false,
  verbose: false,
  quiet: true,
  noColor: true,
};

const FAKE_PLAN = {
  objective: "Split server.ts",
  steps: [{ title: "Create config.ts", description: "Create the ServerConfig interface", filesLikely: ["config.ts"] }],
  riskHints: [],
  scopeSummary: "Split server.ts",
};

/**
 * Byte-identical in shape to runLlmPatchFlow.readOnlySuppression.test.ts's
 * STEPLESS_PLAN — this file measures what dispatch hands over, that file measures
 * what runLlmPatchFlow does with it, and the seam between them is only real if both
 * sides carry the same object shape.
 */
const STEPLESS_PLAN = {
  objective: "Check the build",
  steps: [] as Array<{ title: string; description: string; filesLikely: string[] }>,
  riskHints: [],
  scopeSummary: "Check the build",
  noChangeReason: "Build already exits 0 — the asserted bug does not reproduce.",
};

/** Same shape as STEPLESS_PLAN, answer-shaped instead of no_change-shaped — the
 *  third terminal shape planTerminalShape must recognize at these two arms. */
const ANSWER_ONLY_PLAN = {
  objective: "Explain the marker sink",
  steps: [] as Array<{ title: string; description: string; filesLikely: string[] }>,
  riskHints: [],
  scopeSummary: "Explain the marker sink",
  answerOnlyReason: "The task is a question; nothing needs to change.",
};

const SUCCESS_RESULT = { ok: true, patchPreview: "", warnings: [], decisionMode: "safe_to_apply" as const };

/**
 * Additive lead verb: taskShape.ts's real (unmocked) taskAssertsProblem returns
 * false, which gates OFF E8a (:367) and E8b (:384). Both are guarded on
 * taskAssertsProblem(task), so with an additive task they cannot early-return no
 * matter what isNoChangePlan reports — leaving the replan arms as the only place
 * the stepless plan is observed. That is the isolation this fixture buys.
 */
const ADDITIVE_TASK = "Add a helper function to src/utils/dates.ts";

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRequestPlanApproval.mockReset();
  mockGenerateExecutionPlan.mockReset();
  mockEmitPlanEmptyApproval.mockReset();
  mockDebugLog.mockClear();
  mockLog.mockClear();
  mockRunPlanInvestigation.mockResolvedValue(FAKE_PLAN);
  mockGenerateExecutionPlan.mockResolvedValue(FAKE_PLAN);
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockPreparePlanContext.mockResolvedValue({
    projectSummary: "A TS project",
    relevantFilePaths: [],
    totalFileCount: 954,
    rankedFileScores: [
      { path: "src/utils/atomicWrite.test.ts", score: 51 },
      { path: "src/utils/atomicWrite.ts", score: 51 },
      { path: "src/utils/clipboardMailto.test.ts", score: 51 },
      { path: "src/utils/clipboardMailto.ts", score: 51 },
      { path: "src/utils/commandCacheLog.test.ts", score: 51 },
    ],
    grepMatchedPaths: [
      "src/remote/toWireFrame.ts",
      "src/remote/remoteControlAdapter.test.ts",
      "src/remote/controlServer.ts",
      "src/remote/remoteControlAdapter.ts",
    ],
  });
  mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" });
  // Real predicate, not a constant: executionPlan.ts:38-40's own definition, copied.
  // A `mockReturnValue(true)` here would fire the :488/:525 guard for ANY plan,
  // including the 1-step FAKE_PLAN — the assertions would pass without the stepless
  // plan ever having reached the arm. Keying on the actual object is what makes these
  // tests about plan shape rather than about the mock.
  mockIsNoChangePlan.mockImplementation(
    (p: { steps: unknown[]; noChangeReason?: string }) => p.steps.length === 0 && !!p.noChangeReason
  );
  mockIsCannotVerifyPlan.mockImplementation(
    (p: { steps: unknown[]; cannotVerifyReason?: string }) => p.steps.length === 0 && !!p.cannotVerifyReason
  );
  mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("stepless plan reaching the replan arms — [zone-plan-empty-approval]", () => {
  it("feedback arm (dispatch.ts:488) → reviewed:true, the arm that loops back and IS shown", async () => {
    // First approval → feedback (triggers the replan); the replan returns a stepless
    // plan; second approval → reject, purely to terminate the loop.
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "plan-1", decision: "feedback", feedback: "smaller", modalEmitted: true })
      .mockResolvedValueOnce({ planId: "plan-2", decision: "reject", modalEmitted: true });
    // Call 1 is the initial plan-gen (dispatch.ts:332, quick path — ADDITIVE_TASK is a
    // pure addition). Call 2 is the replan inside the approval loop. Only the replan
    // returns stepless; without this ordering the initial plan would be the stepless
    // one and :400's safety net — not the replan arm — would be what's under test.
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(FAKE_PLAN)
      .mockResolvedValueOnce(STEPLESS_PLAN);

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-stepless-feedback", { mode: "plan" });

    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledTimes(1);
    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledWith({
      runId: "run-stepless-feedback",
      reasonField: "noChangeReason",
      reviewed: true,
    });
  });

  it("approve_with_feedback arm (dispatch.ts:525) → reviewed:false, the unreviewed count the marker exists to measure", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({
      planId: "plan-1",
      decision: "approve_with_feedback",
      feedback: "smaller",
      modalEmitted: true,
    });
    // Call 1 is the initial plan-gen (dispatch.ts:332, quick path — ADDITIVE_TASK is a
    // pure addition). Call 2 is the replan inside the approval loop. Only the replan
    // returns stepless; without this ordering the initial plan would be the stepless
    // one and :400's safety net — not the replan arm — would be what's under test.
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(FAKE_PLAN)
      .mockResolvedValueOnce(STEPLESS_PLAN);

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-stepless-awf", { mode: "plan" });

    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledTimes(1);
    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledWith({
      runId: "run-stepless-awf",
      reasonField: "noChangeReason",
      reviewed: false,
    });
  });

  it("approve_with_feedback hands the stepless plan to runLlmPatchFlow — the seam into the execution-side probe", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({
      planId: "plan-1",
      decision: "approve_with_feedback",
      feedback: "smaller",
      modalEmitted: true,
    });
    // Call 1 is the initial plan-gen (dispatch.ts:332, quick path — ADDITIVE_TASK is a
    // pure addition). Call 2 is the replan inside the approval loop. Only the replan
    // returns stepless; without this ordering the initial plan would be the stepless
    // one and :400's safety net — not the replan arm — would be what's under test.
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(FAKE_PLAN)
      .mockResolvedValueOnce(STEPLESS_PLAN);

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-stepless-handoff", { mode: "plan" });

    expect(mockRunLlmPatchFlow).toHaveBeenCalledTimes(1);
    const flowInput = mockRunLlmPatchFlow.mock.calls[0]![0] as { preGeneratedPlan?: { steps: unknown[]; noChangeReason?: string } };
    expect(flowInput.preGeneratedPlan?.steps).toHaveLength(0);
    expect(flowInput.preGeneratedPlan?.noChangeReason).toBe(STEPLESS_PLAN.noChangeReason);
  });

  it("answer-shaped plan through the feedback arm → reasonField:\"answerOnlyReason\", reviewed:true", async () => {
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "plan-1", decision: "feedback", feedback: "smaller", modalEmitted: true })
      .mockResolvedValueOnce({ planId: "plan-2", decision: "reject", modalEmitted: true });
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(FAKE_PLAN)
      .mockResolvedValueOnce(ANSWER_ONLY_PLAN);

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-answer-feedback", { mode: "plan" });

    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledTimes(1);
    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledWith({
      runId: "run-answer-feedback",
      reasonField: "answerOnlyReason",
      reviewed: true,
    });
  });

  it("answer-shaped plan through the approve_with_feedback arm → reasonField:\"answerOnlyReason\", reviewed:false", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({
      planId: "plan-1",
      decision: "approve_with_feedback",
      feedback: "smaller",
      modalEmitted: true,
    });
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(FAKE_PLAN)
      .mockResolvedValueOnce(ANSWER_ONLY_PLAN);

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-answer-awf", { mode: "plan" });

    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledTimes(1);
    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledWith({
      runId: "run-answer-awf",
      reasonField: "answerOnlyReason",
      reviewed: false,
    });
  });
});

describe("C7 — forceSteps inference on the replan calls is keyed on currentPlan's shape", () => {
  it("answer-shaped currentPlan through the feedback arm → forceSteps:true on the replan call", async () => {
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "plan-1", decision: "feedback", feedback: "give me a fix", modalEmitted: true })
      .mockResolvedValueOnce({ planId: "plan-2", decision: "reject", modalEmitted: true });
    // Call 1 (initial plan-gen) resolves to the answer-shaped plan itself, so
    // currentPlan IS answer-shaped by the time the replan call below is built —
    // forceSteps is evaluated against currentPlan BEFORE this call's own return
    // value overwrites it.
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(ANSWER_ONLY_PLAN)
      .mockResolvedValueOnce(FAKE_PLAN);

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-answer-forcesteps-feedback", { mode: "plan" });

    const replanCall = mockGenerateExecutionPlan.mock.calls[1]![0] as { forceSteps?: boolean };
    expect(replanCall.forceSteps).toBe(true);
  });

  it("normal (real-stepped) currentPlan through the feedback arm → forceSteps stays falsy — the contrast proving the inference is keyed on shape, not hardcoded true", async () => {
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "plan-1", decision: "feedback", feedback: "split step 1", modalEmitted: true })
      .mockResolvedValueOnce({ planId: "plan-2", decision: "reject", modalEmitted: true });
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(FAKE_PLAN)
      .mockResolvedValueOnce(FAKE_PLAN);

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-normal-forcesteps-feedback", { mode: "plan" });

    const replanCall = mockGenerateExecutionPlan.mock.calls[1]![0] as { forceSteps?: boolean };
    expect(replanCall.forceSteps).toBe(false);
  });

  it("answer-shaped currentPlan through the approve_with_feedback arm → forceSteps:true too (the corrected [4] finding — same inference, not hardcoded to only the feedback arm)", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({
      planId: "plan-1",
      decision: "approve_with_feedback",
      feedback: "just do it",
      modalEmitted: true,
    });
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(ANSWER_ONLY_PLAN)
      .mockResolvedValueOnce(FAKE_PLAN);

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-answer-forcesteps-awf", { mode: "plan" });

    const replanCall = mockGenerateExecutionPlan.mock.calls[1]![0] as { forceSteps?: boolean };
    expect(replanCall.forceSteps).toBe(true);
  });
});

// The eight blocks above assert only on values that don't depend on which of
// generateExecutionPlan/runPlanInvestigation supplied the plan (emitPlanEmptyApproval's
// payload, runLlmPatchFlow's input, forceSteps) — a misroute would surface as a confusing
// call-index failure rather than a routing failure. Shape copied from a4824f39's identical
// fix in dispatch.planDecisionMarker.test.ts, not invented here.
describe("ADDITIVE_TASK fixture routes to the lexical branch, not investigation", () => {
  it("generateExecutionPlan is called; runPlanInvestigation is not", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-1", decision: "reject", modalEmitted: true });

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-routing", { mode: "plan" });

    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(1);
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
  });
});
