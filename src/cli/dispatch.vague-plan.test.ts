import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunLlmPatchFlow = vi.hoisted(() => vi.fn());
const mockPreparePlanContext = vi.hoisted(() => vi.fn());
const mockRunPlanInvestigation = vi.hoisted(() => vi.fn());
const mockGenerateExecutionPlan = vi.hoisted(() => vi.fn());
const mockRequestPlanApproval = vi.hoisted(() => vi.fn());
const mockRejectPendingApprovalsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingRevisionsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingPlansForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockClearTrustedCommandsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockSetTrustAllForRun = vi.hoisted(() => vi.fn());
const mockBuildCliSink = vi.hoisted(() => vi.fn(() => ({ onProgress: vi.fn() })));
const mockCreateSpinner = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const mockRunAuditPipeline = vi.hoisted(() => vi.fn());
const mockReadAuditModeSetting = vi.hoisted(() => vi.fn(() => "auto"));
const mockLoadDiskModelSync = vi.hoisted(() => vi.fn(() => null));
const mockIsNoChangePlan = vi.hoisted(() => vi.fn(() => false));
const mockIsCannotVerifyPlan = vi.hoisted(() => vi.fn(() => false));

// Preserve real isChitchat + isVagueDeveloperTask; only stub runLlmPatchFlow.
vi.mock("../core/runLlmPatchFlow.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../core/runLlmPatchFlow.js")>();
  return { ...mod, runLlmPatchFlow: mockRunLlmPatchFlow };
});
vi.mock("../api/commandApprovals.js", () => ({
  rejectPendingApprovalsForRun: mockRejectPendingApprovalsForRun,
  clearTrustedCommandsForRun: mockClearTrustedCommandsForRun,
  setTrustAllForRun: mockSetTrustAllForRun,
}));
vi.mock("../llm/revisionApprovals.js", () => ({ rejectPendingRevisionsForRun: mockRejectPendingRevisionsForRun }));
vi.mock("../llm/planApprovals.js", () => ({
  requestPlanApproval: mockRequestPlanApproval,
  rejectPendingPlansForRun: mockRejectPendingPlansForRun,
}));
vi.mock("./sink.js", () => ({ buildCliSink: mockBuildCliSink, createSpinner: mockCreateSpinner }));
vi.mock("../llm/auditPipeline.js", () => ({ runAuditPipeline: mockRunAuditPipeline }));
vi.mock("../core/preparePlanContext.js", () => ({ preparePlanContext: mockPreparePlanContext }));
vi.mock("../llm/executionPlan.js", () => ({
  generateExecutionPlan: mockGenerateExecutionPlan,
  isNoChangePlan: mockIsNoChangePlan,
  isCannotVerifyPlan: mockIsCannotVerifyPlan,
  synthesizeMinimalPlan: (task: string) => ({ objective: task.slice(0, 200), steps: [{ title: "s", filesLikely: [] }] }),
  tryParseExecutionPlan: () => null,
}));
vi.mock("../visual/tierSettings.js", () => ({ readAuditModeSetting: mockReadAuditModeSetting, readDailyUsdCapOverride: vi.fn() }));
vi.mock("../api/diskModel.js", () => ({ loadDiskModelSync: mockLoadDiskModelSync }));
vi.mock("../llm/planInvestigation.js", () => ({ runPlanInvestigation: mockRunPlanInvestigation }));

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

const PLAN_OPTS = { mode: "plan" as const };

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockPreparePlanContext.mockReset();
  mockRunPlanInvestigation.mockReset();
  mockGenerateExecutionPlan.mockReset();
  mockRequestPlanApproval.mockReset();
  mockPreparePlanContext.mockResolvedValue({ projectSummary: "A TS project", relevantFilePaths: [] });
  mockRunAuditPipeline.mockResolvedValue({ auditFindings: undefined, revisionDecision: undefined, earlyExit: null });
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockReadAuditModeSetting.mockReturnValue("auto");
  mockLoadDiskModelSync.mockReturnValue(null);
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  delete process.env["ZONE_PLAN_APPROVAL_CYCLE"];
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("vague guard on plan path — zero LLM pipeline calls", () => {
  it("'go' returns chat clarification, preparePlanContext never called", async () => {
    const result = await runOneShotInner("go", BASE_CONFIG, "run-vague-1", PLAN_OPTS);

    expect(result).toMatchObject({ ok: true, decisionMode: "chat" });
    expect((result as { chatResponse?: string }).chatResponse).toContain("vague");
    expect(mockPreparePlanContext).not.toHaveBeenCalled();
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
  });

  it("'fix' (1 short word, no target) returns chat clarification", async () => {
    const result = await runOneShotInner("fix", BASE_CONFIG, "run-vague-2", PLAN_OPTS);

    expect(result).toMatchObject({ ok: true, decisionMode: "chat" });
    expect(mockPreparePlanContext).not.toHaveBeenCalled();
  });

  it("'hi' (chitchat) returns chat clarification in plan mode", async () => {
    const result = await runOneShotInner("hi", BASE_CONFIG, "run-vague-3", PLAN_OPTS);

    expect(result).toMatchObject({ ok: true, decisionMode: "chat" });
    expect(mockPreparePlanContext).not.toHaveBeenCalled();
  });

  it("substantive task bypasses the guard and reaches preparePlanContext", async () => {
    // Use quick path so preparePlanContext is called before plan-gen.
    mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" });
    mockGenerateExecutionPlan.mockResolvedValue({
      objective: "fix the auth bug",
      steps: [{ title: "Fix", description: "Fix it", filesLikely: ["src/auth.ts"] }],
      riskHints: [],
      scopeSummary: "Fix auth",
    });
    mockRequestPlanApproval.mockResolvedValue({ planId: "p", decision: "reject" });

    await runOneShotInner("fix the auth bug", BASE_CONFIG, "run-subst-1", PLAN_OPTS);
    expect(mockPreparePlanContext).toHaveBeenCalled();
  });
});
