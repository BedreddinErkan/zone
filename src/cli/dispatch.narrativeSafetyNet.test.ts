import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The stepless safety net in dispatch.ts is the one control-flow site that converts a
 * stepless plan before the modal. This file proves it now excludes the NARRATIVE shape:
 * a narrative-only plan (steps empty, no reason field, prose instead — schema-valid
 * since af9c4ae0's escape valve) reaches the approval modal with its narrative intact,
 * rather than being force-stepped into a fresh structured plan the user never asked for.
 *
 * Why this mattered: planInvestigation.ts's prompt tells the model that `narrative` is
 * what the user reads and approves and that `steps` may be omitted when the work has no
 * natural decomposition. Before this guard, a model that followed that instruction had
 * its narrative discarded by the net's forceSteps regeneration — a call that is passed
 * no previousPlan and whose own prompt never asks for a narrative, so the artifact could
 * not survive it. The user then approved prose from a cold call that had never seen the
 * first one. This is the third terminal shape the net has had to learn; b4488330 taught
 * it the second (answer-only) for the same reason.
 *
 * Harness copied from dispatch.answerOnlySafetyNet.test.ts's mock set, and kept separate
 * from dispatch.steplessReplan.test.ts on that file's own stated grounds: its docstring
 * scopes it to the replan arms, and this scenario is the INITIAL, non-replan plan-gen
 * call already producing the narrative shape — a different code path through the same
 * function.
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
// Real synthesizeMinimalPlan and planTerminalShape/isAnswerOnlyPlan, not stand-ins — the
// whole point of this file is proving the safety net's REAL guard behaves correctly, and
// planTerminalShape IS the guard being tested here. A hand-copied duplicate would prove
// nothing about the precedence this guard depends on.
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
vi.mock("../visual/tierSettings.js", () => ({ readDailyUsdCapOverride: vi.fn() }));
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

const NARRATIVE_TEXT =
  "## What this changes\nAdd a `formatDate` helper to the dates module and use it from the two call sites that hand-roll the same format today.";

/** The INITIAL plan-gen call (not a replan) resolves directly to this. Steps empty and
 *  NO reason field — planTerminalShape classifies it "narrative", which is the guard. */
const NARRATIVE_ONLY_PLAN = {
  objective: "Add a date-formatting helper",
  steps: [] as Array<{ title: string; description: string; filesLikely: string[] }>,
  riskHints: [],
  scopeSummary: "Add a date-formatting helper",
  narrative: NARRATIVE_TEXT,
  filesLikely: ["src/utils/dates.ts"],
};

/** Additive lead verb — real (unmocked) taskAssertsProblem returns false, so E8a/E8b are
 *  gated off regardless; the stepless safety net is the only remaining gate. */
const ADDITIVE_TASK = "Add a helper function to src/utils/dates.ts";

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRequestPlanApproval.mockReset();
  mockGenerateExecutionPlan.mockReset();
  mockEmitPlanEmptyApproval.mockReset();
  (synthesizeMinimalPlan as ReturnType<typeof vi.fn>).mockClear();
  mockDebugLog.mockClear();
  mockLog.mockClear();
  // Single resolution: the INITIAL plan-gen call is the only one this scenario should
  // ever make — a second call would mean the forceSteps regeneration fired.
  mockGenerateExecutionPlan.mockResolvedValue(NARRATIVE_ONLY_PLAN);
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockPreparePlanContext.mockResolvedValue({
    projectSummary: "A TS project",
    relevantFilePaths: [],
    totalFileCount: 954,
    rankedFileScores: [
      { path: "src/utils/dates.ts", score: 51 },
      { path: "src/utils/atomicWrite.ts", score: 51 },
    ],
    grepMatchedPaths: ["src/utils/dates.ts"],
  });
  mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" });
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  // Reject immediately — this test only cares that the modal was reached with the right
  // (unconverted) plan, not about anything past that.
  mockRequestPlanApproval.mockResolvedValue({ planId: "plan-1", decision: "reject", modalEmitted: true });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Separate `it` blocks per claim, for the reason dispatch.answerOnlySafetyNet.test.ts
 * worked out: Vitest aborts a test at its first failing `expect`, so claims bundled into
 * one block after the call-count assertion are asserted but never evaluated when the
 * guard is removed. Split, the M1 mutation must redden each independently and each
 * failure names its own claim.
 */
describe("stepless safety net excludes the narrative-only shape", () => {
  it("reaches the modal without a forceSteps regeneration", async () => {
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-narrative-initial", { mode: "plan" });

    expect(mockRequestPlanApproval).toHaveBeenCalledTimes(1);
    // Exactly one generateExecutionPlan call (the initial one) — a second would be the
    // safety net's own forceSteps regen attempt.
    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(1);
  });

  it("carries the narrative through to the approval modal intact", async () => {
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-narrative-initial", { mode: "plan" });

    // The user-facing claim, and the one the routing defect actually broke: the prose the
    // prompt calls "what the user reads and approves" is what reaches the modal.
    const proposal = mockRequestPlanApproval.mock.calls[0]![0].proposal;
    expect(proposal.narrative).toBe(NARRATIVE_TEXT);
    expect(proposal.steps).toEqual([]);
  });

  it("is not replaced by a synthesized minimal plan", async () => {
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-narrative-initial", { mode: "plan" });

    expect(synthesizeMinimalPlan).not.toHaveBeenCalled();
  });

  /**
   * The precedence claim the guard's shape depends on, pinned directly rather than left
   * to the comment: a plan carrying BOTH a narrative and a noChangeReason classifies as
   * "no_change", not "narrative", so it is still force-stepped. This is why the guard
   * uses planTerminalShape and not a bare `!!plan.narrative` predicate — that predicate
   * would exempt this plan too, turning a narrower condition into a hole.
   *
   * isNoChangePlan is mocked false here so E8b's own early-exit cannot fire and steal the
   * outcome — this asserts the SAFETY NET's behaviour, not E8b's.
   */
  it("still force-steps a plan carrying a narrative AND a noChangeReason", async () => {
    mockGenerateExecutionPlan.mockResolvedValue({
      ...NARRATIVE_ONLY_PLAN,
      noChangeReason: "Already implemented — nothing to do.",
    });

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-narrative-nochange", { mode: "plan" });

    // Two calls: the initial one plus the safety net's forceSteps regeneration.
    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(2);
  });
});
