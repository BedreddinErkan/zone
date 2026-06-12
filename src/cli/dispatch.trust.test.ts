import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must be hoisted before any imports that use the module
const mockRunLlmPatchFlow = vi.hoisted(() => vi.fn());
const mockRejectPendingApprovalsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingRevisionsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingPlansForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingEditsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockRejectPendingTrustForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockClearTrustedCommandsForRun = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockSetTrustAllForRun = vi.hoisted(() => vi.fn());
const mockRequestPlanApproval = vi.hoisted(() => vi.fn());
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
const mockIsProjectTrusted = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockAddTrustedProject = vi.hoisted(() => vi.fn());
const mockResolveProjectRoot = vi.hoisted(() => vi.fn().mockReturnValue("/tmp/test-repo"));
const mockRequestTrustApproval = vi.hoisted(() => vi.fn());

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
vi.mock("../api/editApprovals.js", () => ({
  rejectPendingEditsForRun: mockRejectPendingEditsForRun,
}));
vi.mock("../api/diskTrustedProjects.js", () => ({
  isProjectTrusted: mockIsProjectTrusted,
  addTrustedProject: mockAddTrustedProject,
  resolveProjectRoot: mockResolveProjectRoot,
  canonicalizePath: (p: string) => p,
}));
vi.mock("../core/pathSafety.js", () => ({
  classifyPath: () => "normal",  // default: all test dirs are normal
}));
vi.mock("../api/trustApprovals.js", () => ({
  requestTrustApproval: mockRequestTrustApproval,
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

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockIsProjectTrusted.mockReturnValue(false);
  mockResolveProjectRoot.mockReturnValue("/tmp/test-repo");
  mockAddTrustedProject.mockReset();
  mockRequestTrustApproval.mockReset();
  mockRejectPendingTrustForRun.mockClear();
  mockBuildCliSink.mockReturnValue({ onProgress: vi.fn() });
  mockCreateSpinner.mockReturnValue({ stop: vi.fn() });
  mockRunAuditPipeline.mockResolvedValue({ auditFindings: undefined, revisionDecision: undefined, earlyExit: null });
  mockPreparePlanContext.mockResolvedValue({ projectSummary: "A TS project", relevantFilePaths: [] });
  mockGenerateExecutionPlan.mockResolvedValue({ objective: "x", steps: [{ title: "s", filesLikely: [] }], riskHints: [], scopeSummary: "" });
  mockReadAuditModeSetting.mockReturnValue("auto");
  mockLoadDiskModelSync.mockReturnValue(null);
  mockRunPlanInvestigation.mockResolvedValue({ objective: "x", steps: [{ title: "s", filesLikely: [] }], riskHints: [], scopeSummary: "" });
  mockIsNoChangePlan.mockReturnValue(false);
  mockIsCannotVerifyPlan.mockReturnValue(false);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("trust gate — ZONE_TRUST_ALL=1 bypasses gate", () => {
  it("proceeds to runLlmPatchFlow when ZONE_TRUST_ALL=1 (global vitest env)", async () => {
    // Global env has ZONE_TRUST_ALL=1 from vitest.config.ts — gate bypassed
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    const result = await runOneShotInner("fix bug", BASE_CONFIG, "run-trust-1");
    expect(result.ok).toBe(true);
    // Phase 2: isProjectTrusted IS called (gate evaluates all sources), but ZONE_TRUST_ALL wins
    expect(mockRequestTrustApproval).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });
});

describe("trust gate — untrusted project (ZONE_TRUST_ALL unset)", () => {
  beforeEach(() => {
    vi.stubEnv("ZONE_TRUST_ALL", "0");
  });

  it("fails-closed non-interactively when project is untrusted and no TTY", async () => {
    // In test environment, process.stdin.isTTY and process.stdout.isTTY are undefined/false
    mockIsProjectTrusted.mockReturnValue(false);
    const result = await runOneShotInner("fix bug", BASE_CONFIG, "run-trust-noninteractive");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("project_not_trusted_noninteractive");
    // Must not hang or call requestTrustApproval (no TTY)
    expect(mockRequestTrustApproval).not.toHaveBeenCalled();
    // Must not call the flow
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
  });

  it("skips gate when project is already trusted", async () => {
    mockIsProjectTrusted.mockReturnValue(true);
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    const result = await runOneShotInner("fix bug", BASE_CONFIG, "run-trust-already-trusted");
    expect(result.ok).toBe(true);
    expect(mockRequestTrustApproval).not.toHaveBeenCalled();
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("adds project to trusted store when user approves interactively", async () => {
    // Simulate interactive TTY by making requestTrustApproval resolve true
    mockIsProjectTrusted.mockReturnValue(false);
    mockRequestTrustApproval.mockResolvedValueOnce(true);
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);

    // Override isTTY to simulate interactive terminal
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    try {
      const result = await runOneShotInner("fix bug", BASE_CONFIG, "run-trust-interactive-yes");
      expect(result.ok).toBe(true);
      expect(mockAddTrustedProject).toHaveBeenCalledWith("/tmp/test-repo", "user");
      expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    }
  });

  it("returns not-trusted result when user denies interactively", async () => {
    mockIsProjectTrusted.mockReturnValue(false);
    mockRequestTrustApproval.mockResolvedValueOnce(false);

    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    try {
      const result = await runOneShotInner("fix bug", BASE_CONFIG, "run-trust-interactive-no");
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("project_not_trusted");
      expect(mockAddTrustedProject).not.toHaveBeenCalled();
      expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    }
  });
});
