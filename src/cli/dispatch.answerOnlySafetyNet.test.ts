import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The safety net at dispatch.ts:410 (`if (preGeneratedPlan.steps.length === 0 &&
 * !isAnswerOnlyPlan(preGeneratedPlan))`) is the one dispatch.ts control-flow site
 * that converts a stepless plan before the modal — E8a/E8b gate on
 * isCannotVerifyPlan/isNoChangePlan specifically, which are false-by-construction
 * for an answer-shaped plan, so neither needs a change. This file proves the
 * central claim directly: an answer-shaped plan from the INITIAL (non-replan)
 * plan-gen call reaches the approval modal unconverted, rather than being
 * force-stepped or replaced by synthesizeMinimalPlan.
 *
 * Harness copied from dispatch.steplessReplan.test.ts's mock set — this file is
 * deliberately separate from it: that file's own docstring scopes it to the replan
 * arms specifically, and this scenario (the INITIAL plan already being answer-shaped)
 * is a different code path through the same function.
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
const mockRunAuditPipeline = vi.hoisted(() => vi.fn());
const mockPreparePlanContext = vi.hoisted(() => vi.fn());
const mockGenerateExecutionPlan = vi.hoisted(() => vi.fn());
const mockReadAuditModeSetting = vi.hoisted(() => vi.fn(() => "auto"));
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
vi.mock("../llm/auditPipeline.js", () => ({ runAuditPipeline: mockRunAuditPipeline }));
vi.mock("../core/preparePlanContext.js", () => ({ preparePlanContext: mockPreparePlanContext }));
// Real synthesizeMinimalPlan and planTerminalShape/isAnswerOnlyPlan, not stand-ins —
// the whole point of this file is proving the safety net's REAL guard behaves
// correctly, which requires the real predicate, not a hand-copied duplicate of it.
vi.mock("../llm/executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/executionPlan.js")>();
  return {
    planTerminalShape: actual.planTerminalShape,
    isAnswerOnlyPlan: actual.isAnswerOnlyPlan,
    synthesizeMinimalPlan: vi.fn(actual.synthesizeMinimalPlan),
    generateExecutionPlan: mockGenerateExecutionPlan,
    isNoChangePlan: mockIsNoChangePlan,
    isCannotVerifyPlan: mockIsCannotVerifyPlan,
  };
});
vi.mock("../visual/tierSettings.js", () => ({ readAuditModeSetting: mockReadAuditModeSetting, readDailyUsdCapOverride: vi.fn() }));
vi.mock("../api/diskModel.js", () => ({ loadDiskModelSync: mockLoadDiskModelSync }));
vi.mock("../llm/planInvestigation.js", () => ({ runPlanInvestigation: mockRunPlanInvestigation }));
vi.mock("../utils/logger.js", () => ({ debugLog: mockDebugLog, log: mockLog }));

import { runOneShotInner } from "./dispatch.js";
import { synthesizeMinimalPlan } from "../llm/executionPlan.js";

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

/** The INITIAL plan-gen call (not a replan) resolves directly to this. */
const ANSWER_ONLY_PLAN = {
  objective: "Explain the marker sink",
  steps: [] as Array<{ title: string; description: string; filesLikely: string[] }>,
  riskHints: [],
  scopeSummary: "Explain the marker sink",
  answerOnlyReason: "The task is a question; nothing needs to change.",
};

/** Additive lead verb — real (unmocked) taskAssertsProblem returns false, so E8a/E8b
 *  are gated off regardless; the safety net at :410 is the only remaining gate. */
const ADDITIVE_TASK = "Add a helper function to src/utils/dates.ts";

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRequestPlanApproval.mockReset();
  mockGenerateExecutionPlan.mockReset();
  mockEmitPlanEmptyApproval.mockReset();
  (synthesizeMinimalPlan as ReturnType<typeof vi.fn>).mockClear();
  mockDebugLog.mockClear();
  mockLog.mockClear();
  // Single resolution: the INITIAL plan-gen call is the only one this scenario
  // should ever make — a second call would mean the forceSteps regeneration fired.
  mockGenerateExecutionPlan.mockResolvedValue(ANSWER_ONLY_PLAN);
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockRunAuditPipeline.mockResolvedValue({ auditFindings: undefined, revisionDecision: undefined, earlyExit: null });
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
  mockReadAuditModeSetting.mockReturnValue("auto");
  mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" });
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  // Reject immediately — this test only cares that the modal was reached with the
  // right (unconverted) plan, not about anything past that.
  mockRequestPlanApproval.mockResolvedValue({ planId: "plan-1", decision: "reject", modalEmitted: true });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Two `it` blocks, not one, because the guard makes two separable claims and a single
 * test can only ever prove the first of them. Vitest aborts a test at its first failing
 * `expect`, so when this was one block the mutation (dropping `&& !isAnswerOnlyPlan`)
 * failed on the generateExecutionPlan count and never evaluated the synthesis
 * assertion — that claim was asserted but unproven. Split, the same mutation must
 * redden both, and each failure names its own claim.
 *
 * The second claim is genuinely reachable rather than vacuous: dispatch.ts:431 re-tests
 * `steps.length === 0` AFTER the regen and independently of whether it threw, and this
 * file's `mockResolvedValue` (not `...Once`) hands the regen the same stepless plan —
 * so with the guard removed, synthesizeMinimalPlan really does run.
 */
describe("safety net excludes the answer-only shape (dispatch.ts:412)", () => {
  it("reaches the modal without a forceSteps regeneration", async () => {
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-answer-initial", { mode: "plan" });

    // The modal was reached.
    expect(mockRequestPlanApproval).toHaveBeenCalledTimes(1);

    // Exactly one generateExecutionPlan call (the initial one) — a second would be
    // the safety net's own forceSteps regen attempt.
    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(1);
  });

  it("is not replaced by a synthesized minimal plan", async () => {
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-answer-initial", { mode: "plan" });

    expect(synthesizeMinimalPlan).not.toHaveBeenCalled();
  });

  // mockRunPlanInvestigation has no resolved value anywhere in this file — inert today
  // because ADDITIVE_TASK matches the real (unmocked) isPureAddition, not because
  // anything here asserts the routing. Pinning it directly rather than leaving it implicit.
  it("routes to the lexical branch — runPlanInvestigation is not called", async () => {
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-answer-initial", { mode: "plan" });

    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
  });
});
