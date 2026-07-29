import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must be hoisted before any imports that use the module. Same shape as
// dispatch.planGenRunId.test.ts's harness — reused verbatim, not reinvented.
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
vi.mock("../llm/executionPlan.js", () => ({
  generateExecutionPlan: mockGenerateExecutionPlan,
  isNoChangePlan: mockIsNoChangePlan,
  isCannotVerifyPlan: mockIsCannotVerifyPlan,
  synthesizeMinimalPlan: (task: string) => ({
    objective: task.slice(0, 200),
    steps: [{ title: task.slice(0, 80), description: task, filesLikely: [] }],
    riskHints: [],
    scopeSummary: task.slice(0, 160),
  }),
}));
vi.mock("../visual/tierSettings.js", () => ({ readAuditModeSetting: mockReadAuditModeSetting, readDailyUsdCapOverride: vi.fn() }));
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

const SUCCESS_RESULT = { ok: true, patchPreview: "", warnings: [], decisionMode: "safe_to_apply" as const };

// Pure-addition lead verb (taskShape.ts PURE_ADDITION_RE) — isPureAddition() true, so
// dispatch.ts's quick-lexical branch calls generateExecutionPlan directly rather than going
// through runPlanInvestigation, keeping these tests isolated to the switch under test.
const ADDITIVE_TASK = "Add a helper function to src/utils/dates.ts";

function planDecisionCalls(): Array<Record<string, unknown>> {
  return mockLog.mock.calls
    .filter((c) => c[0] === "[zone-plan-decision]")
    .map((c) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

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
  mockRunAuditPipeline.mockResolvedValue({ auditFindings: undefined, revisionDecision: undefined, earlyExit: null });
  mockPreparePlanContext.mockResolvedValue({ projectSummary: "A TS project", relevantFilePaths: [] });
  mockReadAuditModeSetting.mockReturnValue("auto");
  mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" });
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("[zone-plan-decision] fires via log() (unconditional) at every exit from the approval gate", () => {
  it("reject", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-1", decision: "reject", modalEmitted: true });
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-reject", { mode: "plan" });
    const calls = planDecisionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runId: "run-reject", planId: "plan-1", decision: "reject", planAttempt: 1, reviewed: true });
  });

  it("timeout", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-1", decision: "timeout", modalEmitted: true });
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-timeout", { mode: "plan" });
    const calls = planDecisionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ decision: "timeout", planAttempt: 1 });
  });

  it("feedback (loops back, then accept_all to end the run)", async () => {
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "plan-1", decision: "feedback", feedback: "use snake_case", modalEmitted: true })
      .mockResolvedValueOnce({ planId: "plan-2", decision: "accept_all", modalEmitted: true });
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-feedback", { mode: "plan" });
    const calls = planDecisionCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ decision: "feedback", planAttempt: 1 });
  });

  it("refine (loops back, then accept_all to end the run)", async () => {
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "plan-1", decision: "refine", modalEmitted: true })
      .mockResolvedValueOnce({ planId: "plan-2", decision: "accept_all", modalEmitted: true });
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-refine", { mode: "plan" });
    const calls = planDecisionCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ decision: "refine", planAttempt: 1 });
  });

  it("approve_with_feedback", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-1", decision: "approve_with_feedback", feedback: "be concise", modalEmitted: true });
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-awf", { mode: "plan" });
    const calls = planDecisionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ decision: "approve_with_feedback", planAttempt: 1 });
  });

  it("accept_all", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-1", decision: "accept_all", modalEmitted: true });
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-accept", { mode: "plan" });
    const calls = planDecisionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ decision: "accept_all", planAttempt: 1 });
  });

  it("manual", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-1", decision: "manual", modalEmitted: true });
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-manual", { mode: "plan" });
    const calls = planDecisionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ decision: "manual", planAttempt: 1 });
  });
});

describe("[zone-plan-decision] planAttempt sequencing", () => {
  it("feedback then accept_all reports planAttempt 1, then 2 — not 1 twice", async () => {
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "plan-1", decision: "feedback", feedback: "use snake_case", modalEmitted: true })
      .mockResolvedValueOnce({ planId: "plan-2", decision: "accept_all", modalEmitted: true });

    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-sequence", { mode: "plan" });

    const calls = planDecisionCalls();
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c["planAttempt"])).toEqual([1, 2]);
    expect(calls.map((c) => c["decision"])).toEqual(["feedback", "accept_all"]);
  });
});

describe("[zone-plan-decision] reviewed passes through the observed modalEmitted flag", () => {
  it("reviewed:false when the mocked result reports modalEmitted:false", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-1", decision: "accept_all", modalEmitted: false });
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-unreviewed", { mode: "plan" });
    const calls = planDecisionCalls();
    expect(calls[0]).toMatchObject({ reviewed: false });
  });

  it("reviewed:true when the mocked result reports modalEmitted:true", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "plan-1", decision: "accept_all", modalEmitted: true });
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-reviewed", { mode: "plan" });
    const calls = planDecisionCalls();
    expect(calls[0]).toMatchObject({ reviewed: true });
  });
});
