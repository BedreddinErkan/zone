import { describe, it, expect, vi, beforeEach } from "vitest";

// Must be hoisted before any imports that use the module
const mockRunLlmPatchFlow = vi.hoisted(() => vi.fn());
const mockRejectPendingApprovalsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingRevisionsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockClearTrustedCommandsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
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
}));
vi.mock("../llm/revisionApprovals.js", () => ({
  rejectPendingRevisionsForRun: mockRejectPendingRevisionsForRun,
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
  geminiApiKey: undefined,
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
  mockClearTrustedCommandsForRun.mockClear();
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

  it("uses geminiApiKey when provider=gemini (Bug E' fix)", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner(
      "task",
      { ...BASE_CONFIG, provider: "gemini", geminiApiKey: "gem-test-key" },
      "run-6"
    );
    const call = mockRunLlmPatchFlow.mock.calls[0][0] as Record<string, unknown>;
    expect(call.userApiKey).toBe("gem-test-key");
    expect(call.provider).toBe("gemini");
  });

  it("threads provider into withRequestContext so context-driven callers see gemini (Bug B fix)", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner(
      "task",
      { ...BASE_CONFIG, provider: "gemini", geminiApiKey: "gem-test-key" },
      "run-7"
    );
    // withRequestContext is not mocked — the real one is used. The provider must
    // reach runLlmPatchFlow as the first positional arg; downstream callers
    // (classifier, agentLoop) inherit it from the context store.
    const call = mockRunLlmPatchFlow.mock.calls[0][0] as Record<string, unknown>;
    expect(call.provider).toBe("gemini");
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
