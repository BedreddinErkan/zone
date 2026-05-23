import { describe, it, expect, vi, beforeEach } from "vitest";

// Must be hoisted before any imports that use the module
const mockRunLlmPatchFlow = vi.hoisted(() => vi.fn());
const mockRejectPendingApprovalsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingRevisionsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockClearTrustedCommandsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));

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

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRejectPendingApprovalsForRun.mockClear();
  mockRejectPendingRevisionsForRun.mockClear();
  mockClearTrustedCommandsForRun.mockClear();
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
