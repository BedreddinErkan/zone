import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
vi.mock("../core/preparePlanContext.js", () => ({ preparePlanContext: mockPreparePlanContext }));
vi.mock("../llm/executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/executionPlan.js")>();
  return {
    planTerminalShape: actual.planTerminalShape,
    isAnswerOnlyPlan: actual.isAnswerOnlyPlan,
    generateExecutionPlan: mockGenerateExecutionPlan,
    isNoChangePlan: mockIsNoChangePlan,
    isCannotVerifyPlan: mockIsCannotVerifyPlan,
    // synthesizeMinimalPlan is pure — let it run real; the dispatch fallback
    // only calls it when generateExecutionPlan throws in tests.
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

// Import after mocks are registered
import { runOneShotInner, runOneShotFromCli } from "./dispatch.js";
import { getRequestContext } from "../llm/openaiContext.js";

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
  mockGenerateExecutionPlan.mockResolvedValue(FAKE_PLAN);
  mockReadAuditModeSetting.mockReturnValue("auto");
  mockLoadDiskModelSync.mockReturnValue({ version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: "quick", updatedAt: "" });
  mockRunPlanInvestigation.mockResolvedValue(FAKE_PLAN);
  mockRejectPendingStagedForRun.mockClear();
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  // Suppress stdout/stderr in tests
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("propagates BYOK anthropic key into withRequestContext ambient context", async () => {
    // Regression: dispatch previously omitted userApiKey from withRequestContext, so
    // callers like planPatchPreviewWithLlm / planFullPatchWithLlm that call
    // createLLMClient() with no args got source=none for BYOK users.
    let capturedCtxKey: string | undefined;
    mockRunLlmPatchFlow.mockImplementationOnce(async () => {
      capturedCtxKey = getRequestContext()?.userApiKey;
      return SUCCESS_RESULT;
    });
    await runOneShotInner("task", BASE_CONFIG, "run-byok-ctx");
    expect(capturedCtxKey).toBe("sk-ant-test");
  });

  it("propagates BYOK openai key into withRequestContext ambient context", async () => {
    let capturedCtxKey: string | undefined;
    mockRunLlmPatchFlow.mockImplementationOnce(async () => {
      capturedCtxKey = getRequestContext()?.userApiKey;
      return SUCCESS_RESULT;
    });
    await runOneShotInner(
      "task",
      { ...BASE_CONFIG, provider: "openai", openaiApiKey: "sk-openai-test" },
      "run-byok-ctx-openai"
    );
    expect(capturedCtxKey).toBe("sk-openai-test");
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

  it("calls rejectPendingStagedForRun after success", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("task", BASE_CONFIG, "run-cleanup-staged");
    expect(mockRejectPendingStagedForRun).toHaveBeenCalledWith("run-cleanup-staged");
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

  it("plan mode (default): requestPlanApproval called, runAuditPipeline NOT called", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p-default", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-m2", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockRequestPlanApproval).toHaveBeenCalledOnce();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("plan mode + reject: ac.abort() called, runLlmPatchFlow not called, ok:false", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p-rej", decision: "reject" });
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

const REVISED_PLAN = {
  objective: "Add feature X with tests",
  steps: [{ title: "Add feature with tests", filesLikely: ["src/feature.ts"], subagentEligible: false }],
};

describe("runOneShotInner — plan mode paths", () => {
  // These exercise the lexical plan-approval loop (refine/feedback/re-plan via
  // generateExecutionPlan). Pin the lexical planner so the non-additive "do something" task
  // doesn't route to investigation first; the investigation refine path is covered in
  // dispatch.phase2.test.ts.
  beforeEach(() => { vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "0"); });

  it("accept_all: setTrustAllForRun called, preGeneratedPlan threaded to runLlmPatchFlow", async () => {
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

  it("manual: setTrustAllForRun NOT called, runLlmPatchFlow called", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p3", decision: "manual" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-manual", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockSetTrustAllForRun).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("reject: ac.abort(), runLlmPatchFlow NOT called, ok:false", async () => {
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

  it("refine then accept_all: requestPlanApproval called twice, generateExecutionPlan called once for re-plan", async () => {
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(FAKE_PLAN)    // initial plan gen
      .mockResolvedValueOnce(REVISED_PLAN); // re-plan after refine
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "p5a", decision: "refine" })
      .mockResolvedValueOnce({ planId: "p5b", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-refine", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockRequestPlanApproval).toHaveBeenCalledTimes(2);
    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(2); // initial + re-plan
    const replanCall = mockGenerateExecutionPlan.mock.calls[1]![0] as Record<string, unknown>;
    expect(replanCall["previousPlan"]).toEqual(FAKE_PLAN);
    expect(mockPreparePlanContext).toHaveBeenCalledOnce(); // cached — NOT re-called for re-plan
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("feedback: generateExecutionPlan called once for re-plan with previousPlan+userFeedback, runLlmPatchFlow gets revised plan", async () => {
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(FAKE_PLAN)    // initial plan gen
      .mockResolvedValueOnce(REVISED_PLAN); // re-plan after feedback
    mockRequestPlanApproval
      .mockResolvedValueOnce({ planId: "p-fb1", decision: "feedback", feedback: "please add tests" })
      .mockResolvedValueOnce({ planId: "p-fb2", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-feedback", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockPreparePlanContext).toHaveBeenCalledOnce(); // cached, not re-investigated
    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(2); // initial + re-plan
    const replanCall = mockGenerateExecutionPlan.mock.calls[1]![0] as Record<string, unknown>;
    expect(replanCall["previousPlan"]).toEqual(FAKE_PLAN);
    expect(replanCall["userFeedback"]).toBe("please add tests");
    expect(mockRequestPlanApproval).toHaveBeenCalledTimes(2);
    const flowCall = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect((flowCall["preGeneratedPlan"] as any).objective).toBe(REVISED_PLAN.objective);
  });

  it("approve_with_feedback: re-plans once then executes without re-showing modal", async () => {
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(FAKE_PLAN)    // initial plan gen
      .mockResolvedValueOnce(REVISED_PLAN); // re-plan after approve_with_feedback
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p-awf", decision: "approve_with_feedback", feedback: "be concise" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("do something", BASE_CONFIG, "run-awf", {
      mode: "plan",
      externalAc: new AbortController(),
    });
    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(2); // initial + re-plan
    const replanCall = mockGenerateExecutionPlan.mock.calls[1]![0] as Record<string, unknown>;
    expect(replanCall["userFeedback"]).toBe("be concise");
    expect(mockRequestPlanApproval).toHaveBeenCalledOnce(); // NOT re-shown after approve_with_feedback
    const flowCall = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect((flowCall["preGeneratedPlan"] as any).objective).toBe(REVISED_PLAN.objective);
  });

  it("plan gen failure in plan mode: no abort, falls back to runLlmPatchFlow without a plan", async () => {
    mockGenerateExecutionPlan.mockRejectedValueOnce(new Error("plan gen failed"));
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    const ac = new AbortController();
    await runOneShotInner("do something", BASE_CONFIG, "run-no-plan", {
      mode: "plan",
      externalAc: ac,
    });
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["preGeneratedPlan"]).toBeUndefined();
    expect(ac.signal.aborted).toBe(false);
  });

});

describe("runOneShotInner — plan-generation cost accumulation", () => {
  const ZERO_STEP_PLAN = { objective: "Add X", steps: [], riskHints: [], scopeSummary: "Add X." };

  it("threads onCostUsd into the initial gate-flow generateExecutionPlan call", async () => {
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "0");
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p-cost1", decision: "reject" });

    await runOneShotInner("do something", BASE_CONFIG, "run-cost-threading", {
      mode: "plan",
      externalAc: new AbortController(),
    });

    const call = mockGenerateExecutionPlan.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["onCostUsd"]).toEqual(expect.any(Function));
  });

  it("forced-steps second call: onProgress receives the running sum, not just the second call's own figure", async () => {
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "0");
    mockGenerateExecutionPlan
      .mockImplementationOnce(async (input: any) => {
        input.onCostUsd?.(0.01);
        return ZERO_STEP_PLAN;
      })
      .mockImplementationOnce(async (input: any) => {
        input.onCostUsd?.(0.02);
        return FAKE_PLAN;
      });
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p-cost2", decision: "reject" });
    const onProgress = vi.fn();

    await runOneShotInner("do something", BASE_CONFIG, "run-cost-forced-steps", {
      mode: "plan",
      externalAc: new AbortController(),
      onProgress,
    });

    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(2);
    const costUpdates = onProgress.mock.calls
      .map((c) => c[0] as any)
      .filter((u) => u?.progress?.type === "iter_cost_update");
    expect(costUpdates[costUpdates.length - 1]?.progress?.cumulativeCost).toBe(0.03);
  });

  it("mixed case: investigation's own repaint seeds the accumulator before the safety net's call adds to it", async () => {
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "1");
    mockRunPlanInvestigation.mockImplementationOnce(async (input: any) => {
      input.progressCallback?.({
        stage: "iter_cost_update",
        progress: { type: "iter_cost_update", cumulativeCost: 0.05 },
      });
      return ZERO_STEP_PLAN;
    });
    mockGenerateExecutionPlan.mockImplementationOnce(async (input: any) => {
      input.onCostUsd?.(0.02);
      return FAKE_PLAN;
    });
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p-cost3", decision: "reject" });
    const onProgress = vi.fn();

    await runOneShotInner("do something", BASE_CONFIG, "run-cost-mixed", {
      mode: "plan",
      externalAc: new AbortController(),
      onProgress,
    });

    expect(mockRunPlanInvestigation).toHaveBeenCalledTimes(1);
    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(1);
    const costUpdates = onProgress.mock.calls
      .map((c) => c[0] as any)
      .filter((u) => u?.progress?.type === "iter_cost_update");
    expect(costUpdates[costUpdates.length - 1]?.progress?.cumulativeCost).toBe(0.07);
  });
});

// Phase 2b: planDepth routing
describe("runOneShotInner — planDepth routing", () => {
  const PLAN_CONFIG = { ...BASE_CONFIG };
  const AC = () => new AbortController();

  it("planDepth 'investigate': skips plan-gen, calls runLlmPatchFlow with stagedCheckpoint:true, no runPlanInvestigation or generateExecutionPlan", async () => {
    mockLoadDiskModelSync.mockReturnValue({ version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: "investigate", updatedAt: "" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("add pagination", PLAN_CONFIG, "run-inv-1", { mode: "plan", externalAc: AC() });
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    expect(mockPreparePlanContext).not.toHaveBeenCalled();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["stagedCheckpoint"]).toBe(true);
    expect(call["preGeneratedPlan"]).toBeUndefined();
  });

  it("planDepth 'quick': generateExecutionPlan called, requestPlanApproval shown, runPlanInvestigation NOT called, showPostFlushDiffs true", async () => {
    mockLoadDiskModelSync.mockReturnValue({ version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: "quick", updatedAt: "" });
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p2", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("add pagination", PLAN_CONFIG, "run-quick-1", { mode: "plan", externalAc: AC() });
    expect(mockGenerateExecutionPlan).toHaveBeenCalledOnce();
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
    expect(mockRequestPlanApproval).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["stagedCheckpoint"]).toBeFalsy();
    expect(call["showPostFlushDiffs"]).toBe(true);
  });

  it("planDepth undefined (null disk settings) defaults to plan-first (quick) path", async () => {
    mockLoadDiskModelSync.mockReturnValue(null);
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p-def", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("add pagination", PLAN_CONFIG, "run-default-1", { mode: "plan", externalAc: AC() });
    expect(mockGenerateExecutionPlan).toHaveBeenCalledOnce();
    expect(mockRequestPlanApproval).toHaveBeenCalledOnce();
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["stagedCheckpoint"]).toBeFalsy();
    expect(call["showPostFlushDiffs"]).toBe(true);
  });

  it("planDepth 'strict': skips plan-gen, calls runLlmPatchFlow with stagedCheckpoint:true, no generateExecutionPlan", async () => {
    mockLoadDiskModelSync.mockReturnValue({ version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: "strict", updatedAt: "" });
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("add feature", PLAN_CONFIG, "run-strict-1", { mode: "plan", externalAc: AC() });
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["stagedCheckpoint"]).toBe(true);
    expect(call["showPostFlushDiffs"]).toBeFalsy();
  });
});

describe("E8: no-op plan short-circuit — premise verified false", () => {
  const PLAN_CONFIG = { ...BASE_CONFIG };
  const AC = () => new AbortController();
  const NO_CHANGE_PLAN = {
    objective: "Verify build",
    steps: [],
    riskHints: [],
    scopeSummary: "No changes needed.",
    noChangeReason: "npm run build exits 0 — no error to fix",
  };

  beforeEach(() => {
    mockLoadDiskModelSync.mockReturnValue({ version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: "quick", updatedAt: "" });
    mockGenerateExecutionPlan.mockResolvedValueOnce(NO_CHANGE_PLAN);
    mockRunPlanInvestigation.mockResolvedValueOnce(NO_CHANGE_PLAN);
    mockIsNoChangePlan.mockReturnValue(true);
  });

  it("returns ok:false with reason no_change_needed", async () => {
    const result = await runOneShotInner("fix the build error", PLAN_CONFIG, "run-noop-1", { mode: "plan", externalAc: AC() });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("no_change_needed");
  });

  it("does NOT call requestPlanApproval or runLlmPatchFlow", async () => {
    await runOneShotInner("fix the build error", PLAN_CONFIG, "run-noop-2", { mode: "plan", externalAc: AC() });
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
  });

  it("emits a 'Nothing to fix' narration via progressCallback", async () => {
    const onProgress = vi.fn();
    await runOneShotInner("fix the build error", PLAN_CONFIG, "run-noop-3", { mode: "plan", externalAc: AC(), onProgress });
    const narrations = onProgress.mock.calls.filter(
      ([u]: [any]) => u?.progress?.type === "narration" && u?.progress?.title === "Nothing to fix"
    );
    expect(narrations).toHaveLength(1);
    expect(narrations[0]![0].progress.text).toContain("npm run build exits 0");
  });
});

describe("S5: cannotVerify plan short-circuit", () => {
  const PLAN_CONFIG = { ...BASE_CONFIG };
  const AC = () => new AbortController();
  const CANT_VERIFY_PLAN = {
    objective: "Verify build",
    steps: [],
    riskHints: [],
    scopeSummary: "Could not verify.",
    cannotVerifyReason: "Could not verify — npm run build did not run (auto-denied); premise unconfirmed.",
  };

  beforeEach(() => {
    mockLoadDiskModelSync.mockReturnValue({ version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: "quick", updatedAt: "" });
    mockGenerateExecutionPlan.mockResolvedValueOnce(CANT_VERIFY_PLAN);
    mockIsCannotVerifyPlan.mockReturnValue(true);
  });

  it("returns ok:false with reason could_not_verify", async () => {
    const result = await runOneShotInner("fix the build error", PLAN_CONFIG, "run-cantverify-1", { mode: "plan", externalAc: AC() });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("could_not_verify");
  });

  it("does NOT call requestPlanApproval or runLlmPatchFlow", async () => {
    await runOneShotInner("fix the build error", PLAN_CONFIG, "run-cantverify-2", { mode: "plan", externalAc: AC() });
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
  });

  it("emits a 'Could not verify' narration via progressCallback", async () => {
    const onProgress = vi.fn();
    await runOneShotInner("fix the build error", PLAN_CONFIG, "run-cantverify-3", { mode: "plan", externalAc: AC(), onProgress });
    const narrations = onProgress.mock.calls.filter(
      ([u]: [any]) => u?.progress?.type === "narration" && u?.progress?.title === "Could not verify"
    );
    expect(narrations).toHaveLength(1);
    expect(narrations[0]![0].progress.text).toContain("did not run");
  });
});

describe("E8a/E8b: problemWordsPresent && !isPureAddition replaces taskAssertsProblem", () => {
  const PLAN_CONFIG = { ...BASE_CONFIG };
  const AC = () => new AbortController();
  const NO_CHANGE_PLAN = {
    objective: "Verify build",
    steps: [] as { title: string; filesLikely: string[] }[],
    riskHints: [],
    scopeSummary: "No changes needed.",
    noChangeReason: "npm run build exits 0 — no error to fix",
  };
  const CANT_VERIFY_PLAN = {
    objective: "Verify build",
    steps: [] as { title: string; filesLikely: string[] }[],
    riskHints: [],
    scopeSummary: "Could not verify.",
    cannotVerifyReason: "Could not verify — npm run build did not run (auto-denied); premise unconfirmed.",
  };
  const PLAN_WITH_STEPS = {
    objective: "Do the work",
    steps: [{ title: "Step", filesLikely: [] }],
    riskHints: [],
    scopeSummary: "Concrete steps.",
  };

  beforeEach(() => {
    mockLoadDiskModelSync.mockReturnValue({ version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: "quick", updatedAt: "" });
  });

  it("E8a honored for a structural verb with a problem word — previously destroyed by taskAssertsProblem's additive short-circuit", async () => {
    mockGenerateExecutionPlan.mockResolvedValueOnce(CANT_VERIFY_PLAN);
    mockIsCannotVerifyPlan.mockReturnValue(true);
    const result = await runOneShotInner("refactor the module that is broken", PLAN_CONFIG, "run-e8a-structural", { mode: "plan", externalAc: AC() });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("could_not_verify");
  });

  it("E8b honored for a structural verb with a problem word — previously destroyed by taskAssertsProblem's additive short-circuit", async () => {
    mockGenerateExecutionPlan.mockResolvedValueOnce(NO_CHANGE_PLAN);
    mockIsNoChangePlan.mockReturnValue(true);
    const result = await runOneShotInner("refactor the module that is broken", PLAN_CONFIG, "run-e8b-structural", { mode: "plan", externalAc: AC() });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("no_change_needed");
  });

  it("pure addition + problem word ('add error handling') still NOT honored — isPureAddition keeps the guard closed", async () => {
    mockGenerateExecutionPlan.mockResolvedValueOnce(NO_CHANGE_PLAN).mockResolvedValue(PLAN_WITH_STEPS);
    mockIsNoChangePlan.mockReturnValue(true);
    mockRequestPlanApproval.mockResolvedValue({ planId: "p-regression", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
    await runOneShotInner("add error handling", PLAN_CONFIG, "run-pureaddition-guard", { mode: "plan", externalAc: AC() });
    expect(mockRequestPlanApproval).toHaveBeenCalled();
  });

  it("structural verb WITHOUT a problem word still NOT honored — problemWordsPresent alone is not enough, the pure-addition guard isn't what's closing it here", async () => {
    mockGenerateExecutionPlan.mockResolvedValueOnce(NO_CHANGE_PLAN).mockResolvedValue(PLAN_WITH_STEPS);
    mockIsNoChangePlan.mockReturnValue(true);
    mockRequestPlanApproval.mockResolvedValue({ planId: "p-noproblemword", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
    await runOneShotInner("refactor the auth module", PLAN_CONFIG, "run-structural-noproblemword", { mode: "plan", externalAc: AC() });
    expect(mockRequestPlanApproval).toHaveBeenCalled();
  });
});

// ─── Stage 2: create/scaffold tasks reach the modal ───────────────────────────
describe("Stage 2: create-task gate + empty-steps fallback + path-token merge", () => {
  const PLAN_CONFIG = { ...BASE_CONFIG };
  const AC = () => new AbortController();
  const NO_CHANGE_PLAN = {
    objective: "Verify build",
    steps: [] as { title: string; description?: string; filesLikely: string[] }[],
    riskHints: [],
    scopeSummary: "No changes needed.",
    noChangeReason: "npm run build exits 0 — no error to fix",
  };
  const FAKE_PLAN_WITH_FILES = {
    ...FAKE_PLAN,
    steps: [{ title: "Write file", filesLikely: [] }],
  };

  beforeEach(() => {
    mockLoadDiskModelSync.mockReturnValue({
      version: 2, model: "claude-sonnet-4-6", provider: "anthropic",
      planDepth: "quick", updatedAt: "",
    });
    mockGenerateExecutionPlan
      .mockResolvedValueOnce(NO_CHANGE_PLAN)    // initial generate → empty steps
      .mockResolvedValue(FAKE_PLAN_WITH_FILES);  // forceSteps + subsequent calls
    mockIsNoChangePlan.mockReturnValue(true);
    mockIsCannotVerifyPlan.mockReturnValue(false);
    mockRequestPlanApproval.mockResolvedValue({ planId: "p-stage2", decision: "accept_all" });
    mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
  });

  it("create-task-reaches-modal: non-problem task with no_change verdict reaches requestPlanApproval", async () => {
    await runOneShotInner("create hello.ts", PLAN_CONFIG, "run-stage2-modal", {
      mode: "plan", externalAc: AC(),
    });
    expect(mockRequestPlanApproval).toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).toHaveBeenCalled();
  });

  it("create-task-reaches-modal: forceSteps generateExecutionPlan called for empty-steps plan", async () => {
    await runOneShotInner("create hello.ts", PLAN_CONFIG, "run-stage2-forcesteps", {
      mode: "plan", externalAc: AC(),
    });
    expect(mockGenerateExecutionPlan).toHaveBeenCalledWith(
      expect.objectContaining({ forceSteps: true })
    );
  });

  it("create-task-reaches-modal: hello.ts merged into steps[0].filesLikely for scopeGuard", async () => {
    await runOneShotInner("create hello.ts", PLAN_CONFIG, "run-stage2-merge", {
      mode: "plan", externalAc: AC(),
    });
    const proposal = mockRequestPlanApproval.mock.calls[0]![0].proposal as { steps: { filesLikely: string[] }[] };
    expect(proposal.steps[0]!.filesLikely).toContain("hello.ts");
  });

  it("path-token merge runs even when initial plan produced non-empty steps", async () => {
    // Plan gen returns non-empty steps directly — no forceSteps needed.
    const planWithSteps = {
      objective: "Create hello.ts",
      steps: [{ title: "Write file", filesLikely: [] }],
      riskHints: [],
      scopeSummary: "Add hello.ts",
    };
    // Reset clears the NO_CHANGE_PLAN queued by this describe's beforeEach.
    mockGenerateExecutionPlan.mockReset();
    mockGenerateExecutionPlan.mockResolvedValueOnce(planWithSteps);
    mockIsNoChangePlan.mockReturnValue(false);
    mockIsCannotVerifyPlan.mockReturnValue(false);
    await runOneShotInner("create hello.ts", PLAN_CONFIG, "run-stage2-nonfallback", {
      mode: "plan", externalAc: AC(),
    });
    // Only called once (initial plan) — no forceSteps because steps.length > 0
    expect(mockGenerateExecutionPlan).toHaveBeenCalledTimes(1);
    const proposal = mockRequestPlanApproval.mock.calls[0]![0].proposal as { steps: { filesLikely: string[] }[] };
    expect(proposal.steps[0]!.filesLikely).toContain("hello.ts");
  });

  it("empty-steps fallback: synthesizeMinimalPlan used when forceSteps generateExecutionPlan throws", async () => {
    // First call (initial plan) returns empty steps; second call (forceSteps) rejects.
    // mockRejectedValue sets the fallback but doesn't clear the already-queued Once from beforeEach.
    mockGenerateExecutionPlan.mockRejectedValue(new Error("LLM failure (forceSteps test)"));
    await runOneShotInner("create hello.ts", PLAN_CONFIG, "run-stage2-synthesize", {
      mode: "plan", externalAc: AC(),
    });
    // Should still reach the modal (synthesize provided a fallback plan).
    expect(mockRequestPlanApproval).toHaveBeenCalled();
  });

  it("regression: problem task with no_change still short-circuits (E8 gate preserved)", async () => {
    const result = await runOneShotInner("fix the build error", PLAN_CONFIG, "run-stage2-regression", {
      mode: "plan", externalAc: AC(),
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("no_change_needed");
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
  });
});

// ─── Stage 3B: post-approval "Working…" gap fill ─────────────────────────────
describe("Stage 3B: post-approval spinner gap — plan_generation_started 'Working…'", () => {
  const PLAN_CONFIG = { ...BASE_CONFIG };
  const AC = () => new AbortController();

  beforeEach(() => {
    mockLoadDiskModelSync.mockReturnValue({
      version: 2, model: "claude-sonnet-4-6", provider: "anthropic",
      planDepth: "quick", updatedAt: "",
    });
    mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
  });

  it("accept_all: emits plan_generation_started 'Working…' before runLlmPatchFlow", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "pw1", decision: "accept_all" });
    const onProgress = vi.fn();
    await runOneShotInner("do something", PLAN_CONFIG, "run-working-accept", {
      mode: "plan", externalAc: AC(), onProgress,
    });
    const workingEmits = onProgress.mock.calls.filter(
      ([u]: [any]) => u?.progress?.type === "plan_generation_started" && u?.progress?.title === "Working…"
    );
    expect(workingEmits).toHaveLength(1);
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("manual: emits plan_generation_started 'Working…' before runLlmPatchFlow", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "pw2", decision: "manual" });
    const onProgress = vi.fn();
    await runOneShotInner("do something", PLAN_CONFIG, "run-working-manual", {
      mode: "plan", externalAc: AC(), onProgress,
    });
    const workingEmits = onProgress.mock.calls.filter(
      ([u]: [any]) => u?.progress?.type === "plan_generation_started" && u?.progress?.title === "Working…"
    );
    expect(workingEmits).toHaveLength(1);
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("reject: 'Working…' NOT emitted (planForExecution never set)", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "pw3", decision: "reject" });
    const onProgress = vi.fn();
    const ac = AC();
    await runOneShotInner("do something", PLAN_CONFIG, "run-no-working", {
      mode: "plan", externalAc: ac, onProgress,
    });
    const workingEmits = onProgress.mock.calls.filter(
      ([u]: [any]) => u?.progress?.type === "plan_generation_started" && u?.progress?.title === "Working…"
    );
    expect(workingEmits).toHaveLength(0);
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
  });

  it("normal mode: 'Working…' NOT emitted", async () => {
    const onProgress = vi.fn();
    await runOneShotInner("do something", PLAN_CONFIG, "run-no-working-normal", {
      mode: "normal", externalAc: AC(), onProgress,
    });
    const workingEmits = onProgress.mock.calls.filter(
      ([u]: [any]) => u?.progress?.type === "plan_generation_started" && u?.progress?.title === "Working…"
    );
    expect(workingEmits).toHaveLength(0);
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });
});

// ─── Stage 3A: editApprovalMode threading ────────────────────────────────────
describe("Stage 3A: editApprovalMode threading to runLlmPatchFlow", () => {
  const PLAN_CONFIG = { ...BASE_CONFIG };
  const AC = () => new AbortController();

  beforeEach(() => {
    mockLoadDiskModelSync.mockReturnValue({
      version: 2, model: "claude-sonnet-4-6", provider: "anthropic",
      planDepth: "quick", updatedAt: "",
    });
    mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
  });

  it("[2] manual: threads editApprovalMode:'manual' to runLlmPatchFlow", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p-em", decision: "manual" });
    await runOneShotInner("do something", PLAN_CONFIG, "run-manual-mode", {
      mode: "plan", externalAc: AC(),
    });
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["editApprovalMode"]).toBe("manual");
  });

  it("[1] accept_all: threads editApprovalMode:'auto' to runLlmPatchFlow", async () => {
    mockRequestPlanApproval.mockResolvedValueOnce({ planId: "p-ea", decision: "accept_all" });
    await runOneShotInner("do something", PLAN_CONFIG, "run-accept-all-mode", {
      mode: "plan", externalAc: AC(),
    });
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["editApprovalMode"]).toBe("auto");
  });

  it("normal mode: editApprovalMode is 'auto' (no plan block)", async () => {
    await runOneShotInner("do something", PLAN_CONFIG, "run-normal-mode", {
      mode: "normal", externalAc: AC(),
    });
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["editApprovalMode"]).toBe("auto");
  });
});

// ─── R3 Stage 2b: staged-checkpoint investigate path ─────────────────────────
describe("plan mode — staged checkpoint (investigate depth)", () => {
  const PLAN_CONFIG = { ...BASE_CONFIG };
  const AC = () => new AbortController();

  beforeEach(() => {
    mockLoadDiskModelSync.mockReturnValue({
      version: 2, model: "claude-sonnet-4-6", provider: "anthropic",
      planDepth: "investigate", updatedAt: "",
    });
  });

  it("skips plan-gen, calls runLlmPatchFlow with stagedCheckpoint:true and no preGeneratedPlan", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("add feature", PLAN_CONFIG, "run-ck-1", { mode: "plan", externalAc: AC() });
    expect(mockPreparePlanContext).not.toHaveBeenCalled();
    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["stagedCheckpoint"]).toBe(true);
    expect(call["preGeneratedPlan"]).toBeUndefined();
  });

  it("staged_rejected: returns {ok:false, reason:'plan_rejected_by_user'}", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce({ ok: false, reason: "staged_rejected" });
    const result = await runOneShotInner("add feature", PLAN_CONFIG, "run-ck-reject", { mode: "plan", externalAc: AC() });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe("plan_rejected_by_user");
  });

  it("staged_refine_requested: re-runs runLlmPatchFlow with restageSeed and accumulated feedback", async () => {
    const seed = new Map([["/tmp/test-repo/src/foo.ts", "// v1"]]);
    mockRunLlmPatchFlow
      .mockResolvedValueOnce({ ok: false, reason: "staged_refine_requested", refineFeedback: "use warn not debug", discardedStaging: seed })
      .mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("add feature", PLAN_CONFIG, "run-ck-refine", { mode: "plan", externalAc: AC() });
    expect(mockRunLlmPatchFlow).toHaveBeenCalledTimes(2);
    const secondCall = mockRunLlmPatchFlow.mock.calls[1]![0] as Record<string, unknown>;
    expect(secondCall["restageSeed"]).toBe(seed);
    expect(secondCall["maxIterationsOverride"]).toBe(6);
    const taskStr = secondCall["task"] as string;
    expect(taskStr).toContain("USER REFINEMENT");
    expect(taskStr).toContain("use warn not debug");
  });

  it("staged_refine_requested: feedback accumulates; most-recent seed used", async () => {
    const seed1 = new Map([["/tmp/test-repo/a.ts", "v1"]]);
    const seed2 = new Map([["/tmp/test-repo/a.ts", "v2"]]);
    mockRunLlmPatchFlow
      .mockResolvedValueOnce({ ok: false, reason: "staged_refine_requested", refineFeedback: "foo", discardedStaging: seed1 })
      .mockResolvedValueOnce({ ok: false, reason: "staged_refine_requested", refineFeedback: "bar", discardedStaging: seed2 })
      .mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("add feature", PLAN_CONFIG, "run-ck-multi", { mode: "plan", externalAc: AC() });
    expect(mockRunLlmPatchFlow).toHaveBeenCalledTimes(3);
    const thirdCall = mockRunLlmPatchFlow.mock.calls[2]![0] as Record<string, unknown>;
    expect(thirdCall["restageSeed"]).toBe(seed2);  // most recent seed
    const taskStr = thirdCall["task"] as string;
    expect(taskStr).toContain("foo");
    expect(taskStr).toContain("bar");
  });

  it("headless (no TTY): autoApprove is true in the runLlmPatchFlow call", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      await runOneShotInner("add feature", PLAN_CONFIG, "run-ck-headless", { mode: "plan", externalAc: AC() });
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
    }
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["autoApprove"]).toBe(true);
  });

  it("success result passes through without modification", async () => {
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    const result = await runOneShotInner("add feature", PLAN_CONFIG, "run-ck-pass", { mode: "plan", externalAc: AC() });
    expect(result.ok).toBe(true);
    expect((result as typeof SUCCESS_RESULT).decisionMode).toBe("safe_to_apply");
  });
});
