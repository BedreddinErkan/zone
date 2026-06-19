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
const mockCanonicalizePathDisk = vi.hoisted(() => vi.fn((p: string) => p));
const mockResolveProjectRoot = vi.hoisted(() => vi.fn().mockReturnValue("/tmp/test-repo"));
const mockRequestTrustApproval = vi.hoisted(() => vi.fn());
// classifyPath defaults to "normal" so existing gate-bypass tests aren't affected
const mockClassifyPath = vi.hoisted(() => vi.fn().mockReturnValue("normal"));

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
  canonicalizePath: mockCanonicalizePathDisk,
}));
vi.mock("../api/trustApprovals.js", () => ({
  requestTrustApproval: mockRequestTrustApproval,
  rejectPendingTrustForRun: mockRejectPendingTrustForRun,
}));
vi.mock("../core/pathSafety.js", () => ({
  classifyPath: mockClassifyPath,
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
import { getRequestContext } from "../llm/openaiContext.js";

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
  trust: undefined as boolean | undefined,
};

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockClassifyPath.mockReturnValue("normal");
  mockIsProjectTrusted.mockReturnValue(false);
  mockResolveProjectRoot.mockReturnValue("/tmp/test-repo");
  mockCanonicalizePathDisk.mockImplementation((p: string) => p);
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

describe("Phase 2 gate — hard blocks (override all flags)", () => {
  beforeEach(() => vi.stubEnv("ZONE_TRUST_ALL", "0"));

  it("system path → system_path_blocked even with ZONE_TRUST_ALL=1 and trust:true", async () => {
    mockClassifyPath.mockReturnValue("system");
    vi.stubEnv("ZONE_TRUST_ALL", "1");
    const result = await runOneShotInner("fix bug", { ...BASE_CONFIG, trust: true }, "p2-system-1");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("system_path_blocked");
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
  });

  it("home_root path → home_root_blocked", async () => {
    mockClassifyPath.mockReturnValue("home_root");
    const result = await runOneShotInner("fix bug", BASE_CONFIG, "p2-home-1");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("home_root_blocked");
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
  });
});

describe("Phase 2 gate — --no-trust deny (normal dir)", () => {
  beforeEach(() => vi.stubEnv("ZONE_TRUST_ALL", "0"));

  it("--no-trust on a registered dir → trust_explicitly_declined", async () => {
    mockIsProjectTrusted.mockReturnValue(true); // registered
    const result = await runOneShotInner("fix bug", { ...BASE_CONFIG, trust: false }, "p2-notrust-1");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("trust_explicitly_declined");
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
  });

  it("--trust + --no-trust → trust===false → denied", async () => {
    // parseTrustFlag returns false when both are present (--no-trust wins)
    // Simulated here by passing trust: false directly
    const result = await runOneShotInner("fix bug", { ...BASE_CONFIG, trust: false }, "p2-both-flags");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("trust_explicitly_declined");
  });
});

describe("Phase 2 gate — --trust flag (normal dir)", () => {
  beforeEach(() => vi.stubEnv("ZONE_TRUST_ALL", "0"));

  it("--trust on unregistered dir, non-TTY → proceed AND addTrustedProject called with 'flag'", async () => {
    mockIsProjectTrusted.mockReturnValue(false);
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    const result = await runOneShotInner("fix bug", { ...BASE_CONFIG, trust: true }, "p2-trust-flag");
    expect(result.ok).toBe(true);
    expect(mockAddTrustedProject).toHaveBeenCalledWith("/tmp/test-repo", "flag");
    expect(mockRequestTrustApproval).not.toHaveBeenCalled(); // no prompt needed
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("--trust on already-registered dir → addTrustedProject still called (idempotent)", async () => {
    mockIsProjectTrusted.mockReturnValue(true);
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    await runOneShotInner("fix bug", { ...BASE_CONFIG, trust: true }, "p2-trust-flag-registered");
    expect(mockAddTrustedProject).toHaveBeenCalledWith("/tmp/test-repo", "flag");
  });
});

describe("Phase 2 gate — ZONE_TRUST_DIR (normal dir)", () => {
  beforeEach(() => vi.stubEnv("ZONE_TRUST_ALL", "0"));

  it("ZONE_TRUST_DIR match → proceed, addTrustedProject NOT called", async () => {
    vi.stubEnv("ZONE_TRUST_DIR", "/tmp");
    // projectRoot is /tmp/test-repo which starts with /tmp + sep
    mockIsProjectTrusted.mockReturnValue(false);
    mockRunLlmPatchFlow.mockResolvedValueOnce(SUCCESS_RESULT);
    const result = await runOneShotInner("fix bug", BASE_CONFIG, "p2-trustdir-1");
    expect(result.ok).toBe(true);
    expect(mockAddTrustedProject).not.toHaveBeenCalled(); // ZONE_TRUST_DIR is run-only
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("ZONE_TRUST_DIR mismatch → falls through to Phase-1 non-TTY block", async () => {
    vi.stubEnv("ZONE_TRUST_DIR", "/some/other/path");
    mockIsProjectTrusted.mockReturnValue(false);
    const result = await runOneShotInner("fix bug", BASE_CONFIG, "p2-trustdir-mismatch");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("project_not_trusted_noninteractive");
  });
});

describe("Plan path — ZONE_PLAN_INVESTIGATION_FIRST", () => {
  beforeEach(() => {
    vi.stubEnv("ZONE_TRUST_ALL", "1");
    mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
    mockRequestPlanApproval.mockResolvedValue({ decision: "accept_all" });
  });

  it("flag ON: calls runPlanInvestigation and NOT generateExecutionPlan for the initial plan", async () => {
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "1");
    await runOneShotInner("fix bug in auth", BASE_CONFIG, "inv-1", { mode: "plan" });
    expect(mockRunPlanInvestigation).toHaveBeenCalledOnce();
    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
  });

  it("flag=1 + additive task: force on overrides gate → calls runPlanInvestigation", async () => {
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "1");
    await runOneShotInner("add a settings panel", BASE_CONFIG, "inv-2", { mode: "plan" });
    expect(mockRunPlanInvestigation).toHaveBeenCalledOnce();
    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
  });

  it("flag ON + PlanReadyModal feedback/refine: initial plan via runPlanInvestigation, replan via generateExecutionPlan", async () => {
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "1");
    mockRequestPlanApproval
      .mockResolvedValueOnce({ decision: "feedback", feedback: "be more specific" })
      .mockResolvedValueOnce({ decision: "accept_all" });
    await runOneShotInner("fix bug in auth", BASE_CONFIG, "inv-3", { mode: "plan" });
    expect(mockRunPlanInvestigation).toHaveBeenCalledOnce();   // only initial
    expect(mockGenerateExecutionPlan).toHaveBeenCalledOnce();  // only the replan
  });
});

describe("Plan path — ZONE_PLAN_INVESTIGATION_MODEL", () => {
  beforeEach(() => {
    vi.stubEnv("ZONE_TRUST_ALL", "1");
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "1");
    mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
    mockRequestPlanApproval.mockResolvedValue({ decision: "accept_all" });
  });

  it("override set: investigation loop sees the overridden model as modelOverride.high", async () => {
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_MODEL", "claude-haiku-4-5-20251001");
    let capturedHigh: string | undefined;
    mockRunPlanInvestigation.mockImplementationOnce(async () => {
      capturedHigh = getRequestContext()?.modelOverride?.high;
      return { objective: "x", steps: [{ title: "s", description: "", filesLikely: [] }], riskHints: [], scopeSummary: "" };
    });
    await runOneShotInner("fix bug in auth", BASE_CONFIG, "inv-model-1", { mode: "plan" });
    expect(capturedHigh).toBe("claude-haiku-4-5-20251001");
    expect(mockRunPlanInvestigation).toHaveBeenCalledOnce();
  });

  it("override unset: investigation loop inherits BASE_CONFIG model as modelOverride.high", async () => {
    let capturedHigh: string | undefined;
    mockRunPlanInvestigation.mockImplementationOnce(async () => {
      capturedHigh = getRequestContext()?.modelOverride?.high;
      return { objective: "x", steps: [{ title: "s", description: "", filesLikely: [] }], riskHints: [], scopeSummary: "" };
    });
    await runOneShotInner("fix bug in auth", BASE_CONFIG, "inv-model-2", { mode: "plan" });
    expect(capturedHigh).toBe(BASE_CONFIG.model);  // "claude-sonnet-4-6"
    expect(mockRunPlanInvestigation).toHaveBeenCalledOnce();
  });
});

describe("Plan path — gated investigation routing (taskAssertsProblem)", () => {
  beforeEach(() => {
    vi.stubEnv("ZONE_TRUST_ALL", "1");
    mockRunLlmPatchFlow.mockResolvedValue(SUCCESS_RESULT);
    mockRequestPlanApproval.mockResolvedValue({ decision: "accept_all" });
  });

  it("flag unset + problem task: gated default routes to runPlanInvestigation", async () => {
    await runOneShotInner("fix bug in auth", BASE_CONFIG, "inv-gate-1", { mode: "plan" });
    expect(mockRunPlanInvestigation).toHaveBeenCalledOnce();
    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
  });

  it("flag unset + additive task: gated default routes to generateExecutionPlan", async () => {
    await runOneShotInner("add a settings panel", BASE_CONFIG, "inv-gate-2", { mode: "plan" });
    expect(mockGenerateExecutionPlan).toHaveBeenCalledOnce();
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
  });

  it("flag=1 + additive task: force on overrides gate → runPlanInvestigation", async () => {
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "1");
    await runOneShotInner("add a settings panel", BASE_CONFIG, "inv-gate-3", { mode: "plan" });
    expect(mockRunPlanInvestigation).toHaveBeenCalledOnce();
    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
  });

  it("flag=0 + problem task: force off overrides gate → generateExecutionPlan", async () => {
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "0");
    await runOneShotInner("fix bug in auth", BASE_CONFIG, "inv-gate-4", { mode: "plan" });
    expect(mockGenerateExecutionPlan).toHaveBeenCalledOnce();
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
  });
});
