import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must be hoisted before any imports that use the module
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
vi.mock("../llm/executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/executionPlan.js")>();
  return {
    planTerminalShape: actual.planTerminalShape,
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

// Import after mocks are registered
import { runOneShotInner } from "./dispatch.js";

const SUCCESS_RESULT = { ok: true, patchPreview: "", warnings: [], decisionMode: "safe_to_apply" as const };

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

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRequestPlanApproval.mockReset();
  mockGenerateExecutionPlan.mockReset();
  mockEmitPlanEmptyApproval.mockReset();
  mockRunPlanInvestigation.mockResolvedValue(FAKE_PLAN);
  mockGenerateExecutionPlan.mockResolvedValue(FAKE_PLAN);
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockRunAuditPipeline.mockResolvedValue({ auditFindings: undefined, revisionDecision: undefined, earlyExit: null });
  mockPreparePlanContext.mockResolvedValue({ projectSummary: "A TS project", relevantFilePaths: [] });
  mockReadAuditModeSetting.mockReturnValue("auto");
  mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" }); // quick path → preparePlanContext + generateExecutionPlan + requestPlanApproval
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Fix A — feedback threaded into task for runLlmPatchFlow", () => {
  it("appends USER REFINEMENT block when approve_with_feedback has feedback", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({
      planId: "plan-1",
      decision: "approve_with_feedback",
      feedback: "Name the interface ServerOptions, not ServerConfig",
    });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    await runOneShotInner("split server.ts into config.ts", BASE_CONFIG, "run-fb-1", { mode: "plan" });

    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const callTask = (mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>).task as string;
    expect(callTask).toContain("USER REFINEMENT");
    expect(callTask).toContain("Name the interface ServerOptions, not ServerConfig");
    expect(callTask).toContain("split server.ts into config.ts");
  });

  it("does NOT append USER REFINEMENT when decision has no feedback (accept_all)", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({
      planId: "plan-2",
      decision: "accept_all",
    });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    const originalTask = "split server.ts into config.ts";
    await runOneShotInner(originalTask, BASE_CONFIG, "run-fb-2", { mode: "plan" });

    const callTask = (mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>).task as string;
    expect(callTask).toBe(originalTask);
    expect(callTask).not.toContain("USER REFINEMENT");
  });

  it("accumulates feedback from multiple [3] rounds before final approval", async () => {
    // Round 1: [3] feedback
    mockRequestPlanApproval.mockResolvedValueOnce({
      planId: "plan-3a",
      decision: "feedback",
      feedback: "Name the interface ServerOptions",
    });
    // Round 2: [4] approve_with_feedback with more feedback
    mockRequestPlanApproval.mockResolvedValueOnce({
      planId: "plan-3b",
      decision: "approve_with_feedback",
      feedback: "Use readonly for all fields",
    });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    await runOneShotInner("split server.ts", BASE_CONFIG, "run-fb-3", { mode: "plan" });

    const callTask = (mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>).task as string;
    expect(callTask).toContain("Name the interface ServerOptions");
    expect(callTask).toContain("Use readonly for all fields");
  });
});

describe("Fix B — replan receives abortSignal", () => {
  // Pins the lexical planner: this verifies generateExecutionPlan's replan wiring, not the
  // routing gate. ("split server.ts" is non-additive → would otherwise investigate first.)
  beforeEach(() => { vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "0"); });

  it("passes abortSignal to generateExecutionPlan on replan", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({
      planId: "plan-4",
      decision: "approve_with_feedback",
      feedback: "some feedback",
    });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    await runOneShotInner("split server.ts", BASE_CONFIG, "run-fb-4", { mode: "plan" });

    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(2); // initial plan + replan after approve_with_feedback
    const replanInput = mockGenerateExecutionPlan.mock.calls[1]![0] as Record<string, unknown>;
    expect(replanInput.abortSignal).toBeDefined();
  });
});

// Reachability proof: none of E8a/E8b/the forceSteps safety net re-run on a
// replanned currentPlan, so a schema-valid stepless-with-reason response can
// reach requestPlanApproval a second time (feedback/refine — the user sees it)
// or skip it entirely (approve_with_feedback — the plan proceeds to execution
// unreviewed). isNoChangePlan/isCannotVerifyPlan are mocked identity checks
// here (`plan === STEPLESS_..._PLAN`), so the INITIAL preGeneratedPlan (FAKE_PLAN)
// still clears E8a/E8b normally and only the replanned object trips them.
describe("Reachable gap — a replanned stepless plan carrying a reason", () => {
  beforeEach(() => { vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "0"); });

  const STEPLESS_NOCHANGE_PLAN = {
    objective: "No changes needed",
    steps: [] as never[],
    riskHints: [],
    scopeSummary: "Verified clean",
    noChangeReason: "Build already exits 0 — the asserted bug does not reproduce.",
  };

  const STEPLESS_CANNOTVERIFY_PLAN = {
    objective: "Could not verify",
    steps: [] as never[],
    riskHints: [],
    scopeSummary: "Reproduce blocked",
    cannotVerifyReason: "Reproduce command was blocked — could not confirm the premise.",
  };

  it("feedback: loops back into requestPlanApproval with the reason on the second call's proposal", async () => {
    mockIsNoChangePlan.mockImplementation((plan: unknown) => plan === STEPLESS_NOCHANGE_PLAN);
    mockGenerateExecutionPlan.mockResolvedValueOnce(FAKE_PLAN);
    mockGenerateExecutionPlan.mockResolvedValueOnce(STEPLESS_NOCHANGE_PLAN);
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-5a", decision: "feedback", feedback: "recheck this" });
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-5b", decision: "reject" });

    await runOneShotInner("fix the off-by-one", BASE_CONFIG, "run-empty-1", { mode: "plan" });

    expect(mockRequestPlanApproval).toHaveBeenCalledTimes(2);
    const secondProposal = (mockRequestPlanApproval.mock.calls[1]![0] as {
      proposal: { noChangeReason?: string; steps: unknown[] };
    }).proposal;
    expect(secondProposal.steps).toHaveLength(0);
    expect(secondProposal.noChangeReason).toBe(STEPLESS_NOCHANGE_PLAN.noChangeReason);
  });

  it("emits [zone-plan-empty-approval] reviewed:true on the feedback/refine arm", async () => {
    mockIsNoChangePlan.mockImplementation((plan: unknown) => plan === STEPLESS_NOCHANGE_PLAN);
    mockGenerateExecutionPlan.mockResolvedValueOnce(FAKE_PLAN);
    mockGenerateExecutionPlan.mockResolvedValueOnce(STEPLESS_NOCHANGE_PLAN);
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-6a", decision: "refine" });
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-6b", decision: "reject" });

    await runOneShotInner("fix the off-by-one", BASE_CONFIG, "run-empty-2", { mode: "plan" });

    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledTimes(1);
    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledWith({
      runId: "run-empty-2",
      reasonField: "noChangeReason",
      reviewed: true,
    });
  });

  it("approve_with_feedback: skips requestPlanApproval entirely and proceeds straight to execution", async () => {
    mockIsCannotVerifyPlan.mockImplementation((plan: unknown) => plan === STEPLESS_CANNOTVERIFY_PLAN);
    mockGenerateExecutionPlan.mockResolvedValueOnce(FAKE_PLAN);
    mockGenerateExecutionPlan.mockResolvedValueOnce(STEPLESS_CANNOTVERIFY_PLAN);
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-7", decision: "approve_with_feedback", feedback: "go ahead anyway" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    await runOneShotInner("fix the flaky test", BASE_CONFIG, "run-empty-3", { mode: "plan" });

    // The finding this test pins: no second modal, no review — straight to execution.
    expect(mockRequestPlanApproval).toHaveBeenCalledTimes(1);
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("emits [zone-plan-empty-approval] reviewed:false on the approve_with_feedback arm — the count that matters", async () => {
    mockIsCannotVerifyPlan.mockImplementation((plan: unknown) => plan === STEPLESS_CANNOTVERIFY_PLAN);
    mockGenerateExecutionPlan.mockResolvedValueOnce(FAKE_PLAN);
    mockGenerateExecutionPlan.mockResolvedValueOnce(STEPLESS_CANNOTVERIFY_PLAN);
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-8", decision: "approve_with_feedback", feedback: "go ahead anyway" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    await runOneShotInner("fix the flaky test", BASE_CONFIG, "run-empty-4", { mode: "plan" });

    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledTimes(1);
    expect(mockEmitPlanEmptyApproval).toHaveBeenCalledWith({
      runId: "run-empty-4",
      reasonField: "cannotVerifyReason",
      reviewed: false,
    });
  });

  it("does not emit the marker for an ordinary non-stepless plan", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-9", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    await runOneShotInner("split server.ts", BASE_CONFIG, "run-empty-5", { mode: "plan" });

    expect(mockEmitPlanEmptyApproval).not.toHaveBeenCalled();
  });
});
