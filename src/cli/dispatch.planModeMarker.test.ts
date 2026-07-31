import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Same shape as dispatch.planDecisionMarker.test.ts's harness — reused
// verbatim, not reinvented.
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

// Pure-addition lead verb (taskShape.ts PURE_ADDITION_RE) — isPureAddition() true,
// quick-lexical branch, matchedLeadVerb() === "add".
const ADDITIVE_TASK = "Add a helper function to src/utils/dates.ts";
// No recognized lead verb — isPureAddition() false, investigate-first branch,
// matchedLeadVerb() === null.
const NON_ADDITIVE_TASK = "Why does the marker sink write to the fixed path?";

function planModeCalls(): Array<Record<string, unknown>> {
  return mockLog.mock.calls
    .filter((c) => c[0] === "[zone-plan-mode]")
    .map((c) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

function debugLogPlanModeCalls(): unknown[] {
  return mockDebugLog.mock.calls.filter((c) => c[0] === "[zone-plan-mode]");
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
  mockRequestPlanApproval.mockResolvedValue({ planId: "plan-1", decision: "accept_all", modalEmitted: true });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("[zone-plan-mode] fires via log() (unconditional), never debugLog()", () => {
  it("quick-lexical branch: additive task", async () => {
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-additive", { mode: "plan" });
    expect(debugLogPlanModeCalls()).toHaveLength(0);
    const calls = planModeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runId: "run-additive",
      mode: "quick-lexical",
      gatedBy: "default-non-additive",
      leadVerb: "add",
    });
  });

  it("investigate-first branch: non-additive task", async () => {
    await runOneShotInner(NON_ADDITIVE_TASK, BASE_CONFIG, "run-nonadditive", { mode: "plan" });
    expect(debugLogPlanModeCalls()).toHaveLength(0);
    const calls = planModeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runId: "run-nonadditive",
      mode: "investigate-first",
      gatedBy: "default-non-additive",
      leadVerb: null,
    });
    expect(calls[0]).toHaveProperty("model");
  });
});

describe("gateLeadVerb / gateMode threaded into the runLlmPatchFlow call", () => {
  it("quick-lexical branch forwards leadVerb:\"add\" and mode:\"quick-lexical\"", async () => {
    await runOneShotInner(ADDITIVE_TASK, BASE_CONFIG, "run-thread-additive", { mode: "plan" });
    expect(mockRunLlmPatchFlow).toHaveBeenCalledTimes(1);
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toMatchObject({ gateLeadVerb: "add", gateMode: "quick-lexical" });
  });

  it("investigate-first branch forwards leadVerb:null and mode:\"investigate-first\"", async () => {
    await runOneShotInner(NON_ADDITIVE_TASK, BASE_CONFIG, "run-thread-nonadditive", { mode: "plan" });
    expect(mockRunLlmPatchFlow).toHaveBeenCalledTimes(1);
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toMatchObject({ gateLeadVerb: null, gateMode: "investigate-first" });
  });
});
