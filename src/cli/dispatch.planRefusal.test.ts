import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlanRefusalError } from "../llm/factory.js";

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
const mockDebugLog = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => vi.fn());

vi.mock("../core/runLlmPatchFlow.js", () => ({ runLlmPatchFlow: mockRunLlmPatchFlow, isChitchat: () => false, isVagueDeveloperTask: () => false }));
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
vi.mock("../llm/executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/executionPlan.js")>();
  return {
    planTerminalShape: actual.planTerminalShape,
    generateExecutionPlan: mockGenerateExecutionPlan,
    isNoChangePlan: mockIsNoChangePlan,
    isCannotVerifyPlan: mockIsCannotVerifyPlan,
    synthesizeMinimalPlan: (task: string) => ({ objective: task.slice(0, 200), steps: [{ title: "s", filesLikely: [] }] }),
    tryParseExecutionPlan: () => null,
  };
});
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

beforeEach(() => {
  mockRunLlmPatchFlow.mockReset();
  mockRequestPlanApproval.mockReset();
  mockRunPlanInvestigation.mockReset();
  mockGenerateExecutionPlan.mockReset();
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

afterEach(() => {
  vi.unstubAllEnvs();
});

const PLAN_OPTS = { mode: "plan" as const };

describe("Investigate path (checkpoint loop) — no plan-gen step", () => {
  // planDepth:"investigate" → useCheckpointLoop:true → runLlmPatchFlow(stagedCheckpoint:true).
  // runPlanInvestigation and requestPlanApproval are never called on this path.
  beforeEach(() => {
    mockLoadDiskModelSync.mockReturnValue({ version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: "investigate", updatedAt: "" });
  });

  it("runPlanInvestigation is never called on investigate path", async () => {
    mockRunLlmPatchFlow.mockResolvedValue({ ok: true, decisionMode: "safe_to_apply" });
    await runOneShotInner("secure a route", BASE_CONFIG, "run-1", PLAN_OPTS);
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
  });

  it("runLlmPatchFlow is called with stagedCheckpoint:true", async () => {
    mockRunLlmPatchFlow.mockResolvedValue({ ok: true, decisionMode: "safe_to_apply" });
    await runOneShotInner("task", BASE_CONFIG, "run-2", PLAN_OPTS);
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["stagedCheckpoint"]).toBe(true);
  });

  it("requestPlanApproval is never called on investigate path", async () => {
    mockRunLlmPatchFlow.mockResolvedValue({ ok: true, decisionMode: "safe_to_apply" });
    await runOneShotInner("task", BASE_CONFIG, "run-3", PLAN_OPTS);
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
  });
});

describe("PlanRefusalError — quick path propagation (planDepth=quick)", () => {
  beforeEach(() => {
    // planDepth:"quick" is stored in diskModel
    mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" });
    // Pin the lexical planner: these verify generateExecutionPlan's refusal propagation, not
    // routing. ("secure a route"/"task" are non-additive → would otherwise investigate first.)
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "0");
  });

  it("generateExecutionPlan throws PlanRefusalError → propagates from runOneShotInner", async () => {
    mockGenerateExecutionPlan.mockRejectedValue(new PlanRefusalError("Declined (quick)", 0));

    await expect(runOneShotInner("secure a route", BASE_CONFIG, "run-4", PLAN_OPTS)).rejects.toSatisfy(
      (e: unknown) => e instanceof PlanRefusalError && e.declineReason === "Declined (quick)"
    );
  });

  it("quick-path PlanRefusalError — runLlmPatchFlow is never called", async () => {
    mockGenerateExecutionPlan.mockRejectedValue(new PlanRefusalError("Declined", 0));

    await expect(runOneShotInner("task", BASE_CONFIG, "run-5", PLAN_OPTS)).rejects.toBeInstanceOf(PlanRefusalError);
    expect(mockRunLlmPatchFlow).not.toHaveBeenCalled();
  });
});

describe("Non-refusal plan-gen failure — quick path behavior", () => {
  // On the quick path, generateExecutionPlan can throw. Generic errors are swallowed;
  // PlanRefusalError propagates. runPlanInvestigation is only called on legacy path.
  beforeEach(() => {
    mockLoadDiskModelSync.mockReturnValue({ planDepth: "quick" });
    // Pin the lexical planner: these verify generateExecutionPlan's failure handling, not
    // routing. (Non-additive tasks would otherwise investigate first.)
    vi.stubEnv("ZONE_PLAN_INVESTIGATION_FIRST", "0");
  });

  it("generateExecutionPlan throws generic Error → swallowed; falls back to runLlmPatchFlow without a plan", async () => {
    mockGenerateExecutionPlan.mockRejectedValueOnce(new Error("parse error: bad JSON"));
    mockRunLlmPatchFlow.mockResolvedValueOnce({ ok: true, decisionMode: "safe_to_apply" });

    await runOneShotInner("task", BASE_CONFIG, "run-6", PLAN_OPTS);
    // Non-PlanRefusalError is swallowed; fallback routes to runLlmPatchFlow without preGeneratedPlan.
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["preGeneratedPlan"]).toBeUndefined();
  });

  it("PlanRefusalError propagates; generic error falls back to execution (not plan_gen_failed)", async () => {
    // Confirm error type distinction: PlanRefusalError propagates, generic falls through to agent loop.
    mockGenerateExecutionPlan.mockRejectedValueOnce(new PlanRefusalError("Declined", 0));
    await expect(runOneShotInner("task", BASE_CONFIG, "run-7", PLAN_OPTS)).rejects.toBeInstanceOf(PlanRefusalError);

    mockGenerateExecutionPlan.mockReset();
    mockGenerateExecutionPlan.mockRejectedValueOnce(new Error("unrelated failure"));
    mockRunLlmPatchFlow.mockResolvedValueOnce({ ok: true, decisionMode: "safe_to_apply" });
    await runOneShotInner("task", BASE_CONFIG, "run-8", PLAN_OPTS);
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
  });

  it("empty-dir fallback: preparePlanContext returns empty files → generateExecutionPlan throws → runLlmPatchFlow called without plan", async () => {
    // Regression: empty/non-project dir used to dead-end with plan_gen_failed + ac.abort().
    // Fix: dispatch falls back to runLlmPatchFlow(no preGeneratedPlan) instead.
    mockPreparePlanContext.mockResolvedValueOnce({ projectSummary: "", relevantFilePaths: [] });
    mockGenerateExecutionPlan.mockRejectedValueOnce(new Error("No JSON object found in model response"));
    mockRunLlmPatchFlow.mockResolvedValueOnce({ ok: true, decisionMode: "safe_to_apply" });

    const result = await runOneShotInner("add a logger", BASE_CONFIG, "run-empty-dir", PLAN_OPTS);

    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["preGeneratedPlan"]).toBeUndefined();
    expect(mockRequestPlanApproval).not.toHaveBeenCalled();
    expect((result as any).ok).toBe(true);
  });

  it("parse-robustness: generateExecutionPlan throws on non-JSON prose → dispatch falls back (no abort, no plan_gen_failed)", async () => {
    // Regression: model returning prose instead of JSON used to propagate a parse error that
    // caused dispatch to abort the controller and return {ok:false, reason:"plan_gen_failed"}.
    mockPreparePlanContext.mockResolvedValueOnce({
      projectSummary: "A TS project",
      relevantFilePaths: ["src/index.ts", "src/api.ts"],
    });
    mockGenerateExecutionPlan.mockRejectedValueOnce(new Error("Unexpected token 'I' at position 0"));
    mockRunLlmPatchFlow.mockResolvedValueOnce({ ok: true, decisionMode: "safe_to_apply" });

    const ac = new AbortController();
    const result = await runOneShotInner("refactor the API layer", BASE_CONFIG, "run-parse-err", {
      mode: "plan",
      externalAc: ac,
    });

    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    expect(ac.signal.aborted).toBe(false);
    expect((result as any).ok).toBe(true);
  });

  it("context-read fault, not a plan-gen rejection: preparePlanContext resolves null → property read throws before the gate → swallowed, reason mislabelled empty-context, run continues", async () => {
    // Distinct from every other test in this describe: the throw originates at planCtx.projectSummary
    // (the context builder's return value itself), not from generateExecutionPlan/runPlanInvestigation
    // rejecting. It fires before shouldInvestigate is even computed, so neither generator is reached.
    mockPreparePlanContext.mockResolvedValueOnce(null);
    mockRunLlmPatchFlow.mockResolvedValueOnce({ ok: true, decisionMode: "safe_to_apply" });

    const ac = new AbortController();
    const result = await runOneShotInner("task", BASE_CONFIG, "run-ctx-throw", {
      mode: "plan",
      externalAc: ac,
    });

    expect(mockGenerateExecutionPlan).not.toHaveBeenCalled();
    expect(mockRunPlanInvestigation).not.toHaveBeenCalled();
    // planCtxRelevantFiles is still its outer-scope default ([]) when the catch computes the
    // reason, because the throw fired before the reassignment from planCtx.relevantFilePaths —
    // so a TypeError from a null context is labelled the same as a genuinely empty one. Pinning
    // the current, wrong label — not what it should say.
    expect(mockDebugLog).toHaveBeenCalledWith("[zone-plan-gen-failed]", expect.objectContaining({ reason: "empty-context" }));
    // Swallowed, not propagated — the run continues rather than failing.
    expect(mockRunLlmPatchFlow).toHaveBeenCalledOnce();
    const call = mockRunLlmPatchFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["preGeneratedPlan"]).toBeUndefined();
    expect(ac.signal.aborted).toBe(false);
    expect((result as any).ok).toBe(true);
  });
});
