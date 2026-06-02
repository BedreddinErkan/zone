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

vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: mockRunLlmPatchFlow,
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
vi.mock("../llm/executionPlan.js", () => ({ generateExecutionPlan: mockGenerateExecutionPlan }));
vi.mock("../visual/tierSettings.js", () => ({ readAuditModeSetting: mockReadAuditModeSetting, readDailyUsdCapOverride: vi.fn() }));

// Import after mocks are registered
import { runOneShotInner, runOneShotFromCli } from "./dispatch.js";

const SUCCESS_RESULT = {
  ok: true,
  patchPreview: "",
  warnings: [],
  decisionMode: "safe_to_apply" as const,
};

const FAIL_RESULT = {
  ok: false,
  reason: "verification failed",
};

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
  quiet: true,   // suppress output in tests
  noColor: true,
};

const FAKE_PLAN = {
  objective: "Add feature X",
  steps: [{ title: "Read files", filesLikely: [], subagentEligible: false }],
};

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRejectPendingApprovalsForRun.mockClear();
  mockRejectPendingRevisionsForRun.mockClear();
  mockRejectPendingPlansForRun.mockClear();
  mockRequestPlanApproval.mockReset();
  mockSetTrustAllForRun.mockClear();
  mockClearTrustedCommandsForRun.mockClear();
  delete process.env["ZONE_PLAN_APPROVAL_CYCLE"];
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockRunAuditPipeline.mockResolvedValue({ auditFindings: undefined, revisionDecision: undefined, earlyExit: null });
  mockPreparePlanContext.mockResolvedValue({ projectSummary: "A TS project", relevantFilePaths: [] });
  mockGenerateExecutionPlan.mockResolvedValue(FAKE_PLAN);
  mockReadAuditModeSetting.mockReturnValue("auto");
  // Suppress stdout/stderr in tests
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("runOneShotInner — happy path", () => {
  it("calls runLlmPatchFlow with task, repoPath, provider", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("fix bug", BASE_CONFIG, "run-1");
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0][0] as Record<string, unknown>;
    expect(call.task).toBe("fix bug");
    expect(call.repoPath).toBe("/tmp/test-repo");
    expect(call.provider).toBe("anthropic");
    expect(call.mode).toBe("patch");
  });

  it("passes userApiKey from config.anthropicApiKey", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("task", BASE_CONFIG, "run-2");
    const call = mockRunLlmPatchFlow.mock.calls[0][0] as Record<string, unknown>;
    expect(call.userApiKey).toBe("sk-ant-test");
  });

  it("passes forceTier to runLlmPatchFlow", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("task", { ...BASE_CONFIG, forceTier: "simple" }, "run-3");
    const call = mockRunLlmPatchFlow.mock.calls[0][0] as Record<string, unknown>;
    expect(call.forceTier).toBe("simple");
  });

  it("passes conversationId when provided", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("task", BASE_CONFIG, "run-4", { conversationId: "conv-abc" });
    const call = mockRunLlmPatchFlow.mock.calls[0][0] as Record<string, unknown>;
    expect(call.conversationId).toBe("conv-abc");
  });

  it("uses openaiApiKey when provider=openai", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner(
      "task",
      { ...BASE_CONFIG, provider: "openai", openaiApiKey: "sk-openai-test" },
      "run-5"
    );
    const call = mockRunLlmPatchFlow.mock.calls[0][0] as Record<string, unknown>;
    expect(call.userApiKey).toBe("sk-openai-test");
    expect(call.provider).toBe("openai");
  });


});

describe("runOneShotInner — cleanup in finally", () => {
  it("calls rejectPendingApprovalsForRun after success", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("task", BASE_CONFIG, "run-cleanup-1");
    expect(mockRejectPendingApprovalsForRun).toHaveBeenCalledWith("run-cleanup-1");
  });

  it("calls rejectPendingRevisionsForRun after success", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("task", BASE_CONFIG, "run-cleanup-2");
    expect(mockRejectPendingRevisionsForRun).toHaveBeenCalledWith("run-cleanup-2");
  });

  it("calls clearTrustedCommandsForRun after success", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("task", BASE_CONFIG, "run-cleanup-3");
    expect(mockClearTrustedCommandsForRun).toHaveBeenCalledWith("run-cleanup-3");
  });

  it("calls cleanup even when runLlmPatchFlow throws", async () => {
    mockRunLlmPatchFlow.mockRejectedValueOnce(new Error("network error"));
    await expect(runOneShotInner("task", BASE_CONFIG, "run-err")).rejects.toThrow();
    expect(mockRejectPendingApprovalsForRun).toHaveBeenCalledWith("run-err");
    expect(mockRejectPendingRevisionsForRun).toHaveBeenCalledWith("run-err");
    expect(mockClearTrustedCommandsForRun).toHaveBeenCalledWith("run-err");
  });
});

describe("runOneShotInner — externalAc", () => {
  it("uses provided externalAc signal in runLlmPatchFlow", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    const ac = new AbortController();
    await runOneShotInner("task", BASE_CONFIG, "run-ext", { externalAc: ac });
    const call = mockRunLlmPatchFlow.mock.calls[0][0] as Record<string, unknown>;
    expect(call.abortSignal).toBe(ac.signal);
  });
});

describe("runOneShotFromCli — process.exit behavior", () => {
  it("exits 1 when no API key configured", async () => {
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => { throw new Error("process.exit(1)"); });

    await expect(
      runOneShotFromCli("task", { noColor: true })
    ).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits 0 on success result", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => { throw new Error(`exit:0`); });

    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    await expect(
      runOneShotFromCli("fix bug", { noColor: true, repo: "/tmp" })
    ).rejects.toThrow("exit:0");

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("exits 1 on failure result", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(FAIL_RESULT);
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => { throw new Error(`exit:1`); });

    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    await expect(
      runOneShotFromCli("fix bug", { noColor: true, repo: "/tmp" })
    ).rejects.toThrow("exit:1");

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe("runOneShotInner — mode wiring", () => {
  it("autoAccept passes autoApprove:true to buildCliSink", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-m1", {
      mode: "autoAccept",
      externalAc: new AbortController(),
    });
    const sinkCallArg = mockBuildCliSink.mock.calls[0]![0] as Record<string, unknown>;
    expect(sinkCallArg.autoApprove).toBe(true);
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("plan mode calls runAuditPipeline with forceAudit:true before runLlmPatchFlow", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-m2", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockRunAuditPipeline).toHaveBeenCalledOnce();
    expect(mockRunAuditPipeline.mock.calls[0]![0].forceAudit).toBe(true);
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("plan mode + reject: ac.abort() called, runLlmPatchFlow not called, ok:false", async () => {
    mockRunAuditPipeline.mockResolvedValueOnce({
      auditFindings: undefined,
      revisionDecision: "reject",
      earlyExit: null,
    });
    const ac = new AbortController();
    const result = await runOneShotInner("do something", BASE_CONFIG, "run-m3", {
      mode: "plan",
      externalAc: ac,
    });
    expect(ac.signal.aborted).toBe(true);
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
    expect((result as any).ok).toBe(false);
  });
});

describe("runOneShotInner — ZONE_PLAN_APPROVAL_CYCLE flag", () => {
  it("flag OFF: plan mode still calls runAuditPipeline with forceAudit:true (parity)", async () => {
    // flag is unset (cleared in beforeEach)
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-flag-off", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockRunAuditPipeline).toHaveBeenCalledOnce();
    expect(mockRunAuditPipeline.mock.calls[0]![0].forceAudit).toBe(true);
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("flag ON: requestPlanApproval called, runAuditPipeline NOT called", async () => {
    process.env["ZONE_PLAN_APPROVAL_CYCLE"] = "1";
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p1", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-flag-on", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockRunAuditPipeline).not.toHaveBeenCalled();
    expect(mockRequestPlanApproval).toHaveBeenCalledOnce();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("flag ON + accept_all: setTrustAllForRun called, preGeneratedPlan threaded to runLlmPatchFlow", async () => {
    process.env["ZONE_PLAN_APPROVAL_CYCLE"] = "1";
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p2", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-accept-all", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockSetTrustAllForRun).toHaveBeenCalledWith("run-accept-all");
    const flowCall = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(flowCall["preGeneratedPlan"]).toBeDefined();
    expect((flowCall["preGeneratedPlan"] as any).objective).toBe(FAKE_PLAN.objective);
  });

  it("flag ON + manual: setTrustAllForRun NOT called, runLlmPatchFlow called", async () => {
    process.env["ZONE_PLAN_APPROVAL_CYCLE"] = "1";
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p3", decision: "manual" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-manual", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockSetTrustAllForRun).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("flag ON + reject: ac.abort(), runLlmPatchFlow NOT called, ok:false", async () => {
    process.env["ZONE_PLAN_APPROVAL_CYCLE"] = "1";
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p4", decision: "reject" });
    const ac = new AbortController();
    const result = await runOneShotInner("do something", BASE_CONFIG, "run-reject", {
      mode: "plan",
      externalAc: ac,
    });
    expect(ac.signal.aborted).toBe(true);
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
    expect((result as any).ok).toBe(false);
  });

  it("flag ON + refine then accept_all: requestPlanApproval called twice (stub loop)", async () => {
    process.env["ZONE_PLAN_APPROVAL_CYCLE"] = "1";
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "p5a", decision: "refine" })
      .mockResolvedValueOnce({ planId: "p5b", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-refine", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockRequestPlanApproval).toHaveBeenCalledTimes(2);
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("flag ON: preGeneratedPlan NOT threaded when plan gen fails", async () => {
    process.env["ZONE_PLAN_APPROVAL_CYCLE"] = "1";
    mockGenerateExecutionPlan.mockRejectedValueOnce(new Error("plan gen failed"));
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-no-plan", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    // No approval modal shown (no plan to show), goes straight to execution
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    const flowCall = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(flowCall["preGeneratedPlan"]).toBeUndefined();
  });
});
