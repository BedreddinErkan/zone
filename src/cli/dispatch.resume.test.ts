import { describe, it, expect, vi, beforeEach } from "vitest";

// Must be hoisted before any imports that use the module
const mockRunLlmPatchFlow = vi.hoisted(() => vi.fn());
const mockRejectPendingApprovalsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingRevisionsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingPlansForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRequestPlanApproval = vi.hoisted(() => vi.fn());
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
const mockRejectPendingStagedForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));

vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: mockRunLlmPatchFlow,
  isChitchat: () => false,
  isVagueDeveloperTask: () => false,
}));
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
vi.mock("../api/diskKeys.js", () => ({
  loadDiskKeys: vi.fn().mockResolvedValue({ version: 1 as const, keys: [] }),
  setDiskKey: vi.fn(),
  removeDiskKey: vi.fn(),
  maskKey: vi.fn((k: string) => k),
}));
vi.mock("../llm/planInvestigation.js", () => ({ runPlanInvestigation: mockRunPlanInvestigation }));
vi.mock("../api/stagedApprovals.js", () => ({
  rejectPendingStagedForRun: mockRejectPendingStagedForRun,
  requestStagedApproval: vi.fn(),
  resolveStagedApproval: vi.fn(),
}));

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

const ENVELOPE_PLAN = {
  objective: "Restore interrupted work",
  steps: [{ title: "Continue editing foo.ts", filesLikely: ["src/foo.ts"], description: "Picked up from envelope" }],
  riskHints: [],
  scopeSummary: "Continue foo.ts edit",
};

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRequestPlanApproval.mockReset();
  mockGenerateExecutionPlan.mockReset();
  mockPreparePlanContext.mockReset();
  mockLoadDiskModelSync.mockReturnValue({ version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: "quick", updatedAt: "" });
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("durable resume — preGeneratedPlan bypass (Fix B)", () => {
  it("plan mode + opts.preGeneratedPlan: generateExecutionPlan NOT called, requestPlanApproval NOT called", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    await runOneShotInner("do the task", BASE_CONFIG, "run-resume-1", {
      mode: "plan",
      externalAc: new AbortController(),
      preGeneratedPlan: ENVELOPE_PLAN,
    });

    expect(mockPreparePlanContext).not.toHaveBeenCalled();
    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("plan mode + opts.preGeneratedPlan: runLlmPatchFlow receives the envelope plan", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    await runOneShotInner("do the task", BASE_CONFIG, "run-resume-2", {
      mode: "plan",
      externalAc: new AbortController(),
      preGeneratedPlan: ENVELOPE_PLAN,
    });

    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect((call["preGeneratedPlan"] as typeof ENVELOPE_PLAN).objective).toBe(ENVELOPE_PLAN.objective);
  });

  it("plan mode without opts.preGeneratedPlan: generateExecutionPlan IS called (normal path unchanged)", async () => {
    const normalPlan = { objective: "Fresh plan", steps: [{ title: "Step 1", filesLikely: [], description: "" }], riskHints: [], scopeSummary: "" };
    mockGenerateExecutionPlan.mockResolvedValueOnce(normalPlan);
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p1", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    mockPreparePlanContext.mockResolvedValue({ projectSummary: "A project", relevantFilePaths: [] });

    await runOneShotInner("add something fresh", BASE_CONFIG, "run-normal-plan", {
      mode: "plan",
      externalAc: new AbortController(),
    });

    expect(mockGenerateExecutionPlan).toHaveBeenCalledOnce();
    expect(mockRequestPlanApproval).toHaveBeenCalledOnce();
  });

  it("normal mode + opts.preGeneratedPlan: runLlmPatchFlow receives it at Site 2 (Fix B item 4)", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    await runOneShotInner("do the task", BASE_CONFIG, "run-normal-resume", {
      mode: "normal" as never,
      externalAc: new AbortController(),
      preGeneratedPlan: ENVELOPE_PLAN,
    });

    // generateExecutionPlan must NOT be called (normal mode skips plan block entirely)
    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
    // runLlmPatchFlow must receive the envelope plan via the `?? opts.preGeneratedPlan` fallback
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect((call["preGeneratedPlan"] as typeof ENVELOPE_PLAN).objective).toBe(ENVELOPE_PLAN.objective);
  });

  it("plan mode + opts.preGeneratedPlan + opts.resume: resume payload threaded to runLlmPatchFlow", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    const resumePayload = {
      stagingFiles: new Map([["src/foo.ts", "content"]]),
      todos: [],
      failureHistory: [],
      contextBlock: "RESUMED RUN — continuing interrupted work.",
    };

    await runOneShotInner("do the task", BASE_CONFIG, "run-resume-full", {
      mode: "plan",
      externalAc: new AbortController(),
      preGeneratedPlan: ENVELOPE_PLAN,
      resume: resumePayload,
      sessionId: "env-session-id",
    });

    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["sessionId"]).toBe("env-session-id");
    expect(call["resume"]).toEqual(resumePayload);
    expect((call["preGeneratedPlan"] as typeof ENVELOPE_PLAN).objective).toBe(ENVELOPE_PLAN.objective);
  });

  it("D. Inc-1: resume.messages threads through to runLlmPatchFlow when set", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    const savedMessages = [
      { role: "system", content: "prior system" },
      { role: "user", content: "prior task" },
    ];
    const resumePayload = {
      stagingFiles: new Map<string, string>(),
      todos: [],
      failureHistory: [],
      contextBlock: "RESUMED.",
      messages: savedMessages,
    };

    await runOneShotInner("do the task", BASE_CONFIG, "run-resume-messages", {
      mode: "plan",
      externalAc: new AbortController(),
      preGeneratedPlan: ENVELOPE_PLAN,
      resume: resumePayload,
      sessionId: "env-session-messages",
    });

    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    const resume = call["resume"] as typeof resumePayload;
    expect(resume.messages).toEqual(savedMessages);
  });
});
