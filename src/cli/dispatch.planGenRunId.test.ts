import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must be hoisted before any imports that use the module. Same shape as
// dispatch.feedback.test.ts's harness — reused verbatim, not reinvented.
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
const mockReadAuditModeSetting = vi.hoisted(() => vi.fn(() => "auto"));
const mockLoadDiskModelSync = vi.hoisted(() => vi.fn(() => null));
const mockRunPlanInvestigation = vi.hoisted(() => vi.fn());
const mockIsNoChangePlan = vi.hoisted(() => vi.fn());
const mockIsCannotVerifyPlan = vi.hoisted(() => vi.fn());

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
vi.mock("../llm/executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/executionPlan.js")>();
  return {
    planTerminalShape: actual.planTerminalShape,
    // Real predicate (C7): both replan call sites now call isAnswerOnlyPlan
    // unconditionally to build forceSteps.
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
vi.mock("../visual/tierSettings.js", () => ({ readAuditModeSetting: mockReadAuditModeSetting, readDailyUsdCapOverride: vi.fn() }));
vi.mock("../api/diskModel.js", () => ({ loadDiskModelSync: mockLoadDiskModelSync }));
vi.mock("../llm/planInvestigation.js", () => ({ runPlanInvestigation: mockRunPlanInvestigation }));

// NOT mocked, deliberately: ../llm/openaiContext.js. The real AsyncLocalStorage-based
// ambient context is what this file verifies — dispatch.ts's planGenCtx must carry the
// run's runId into it, not a hand-rolled stand-in for the context mechanism.
import { getRequestContext } from "../llm/openaiContext.js";
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

const SUCCESS_RESULT = { ok: true, patchPreview: "", warnings: [], decisionMode: "safe_to_apply" as const };

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRequestPlanApproval.mockReset();
  mockGenerateExecutionPlan.mockReset();
  mockEmitPlanEmptyApproval.mockReset();
  mockRunPlanInvestigation.mockResolvedValue(FAKE_PLAN);
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockPreparePlanContext.mockResolvedValue({ projectSummary: "A TS project", relevantFilePaths: [] });
  mockReadAuditModeSetting.mockReturnValue("auto");
  mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" }); // quick path → preparePlanContext + generateExecutionPlan + requestPlanApproval
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("plan-generation calls carry the run's runId in ambient context", () => {
  // "Add ..." is a pure-addition lead verb (taskShape.ts PURE_ADDITION_RE) — isPureAddition()
  // returns true, so dispatch.ts's shouldInvestigate is false and the quick-lexical branch
  // calls generateExecutionPlan directly (dispatch.ts's initial call site), rather than going
  // through runPlanInvestigation first. That keeps this test isolated to the call site under
  // test instead of also depending on the investigation-loop mock.
  const ADDITIVE_TASK = "Add a helper function to src/utils/dates.ts";

  it("the initial quick-lexical generateExecutionPlan call carries the run's runId", async () => {
    let capturedRunId: string | undefined;
    mockGenerateExecutionPlan.mockImplementation(async () => {
      capturedRunId = getRequestContext()?.runId;
      return FAKE_PLAN;
    });
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-1", decision: "accept_all" });

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "the-run-id", { mode: "plan" });

    expect(mockGenerateExecutionPlan).toHaveBeenCalledOnce();
    expect(capturedRunId).toBe("the-run-id");
  });

  it("a replan (feedback) call carries the same runId as the initial call", async () => {
    const capturedRunIds: Array<string | undefined> = [];
    mockGenerateExecutionPlan.mockImplementation(async () => {
      capturedRunIds.push(getRequestContext()?.runId);
      return FAKE_PLAN;
    });
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "plan-1", decision: "feedback", feedback: "use snake_case" })
      .mockResolvedValueOnce({ planId: "plan-2", decision: "accept_all" });

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "the-run-id-2", { mode: "plan" });

    // Two distinct call sites fire here: the initial quick-lexical call, then one replan
    // (dispatch.ts's "feedback"/"refine" case). Both must share the run's runId.
    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(2);
    expect(capturedRunIds).toEqual(["the-run-id-2", "the-run-id-2"]);
  });
});
