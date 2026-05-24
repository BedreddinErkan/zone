import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./auditMode.js", () => ({ shouldRunAudit: vi.fn(), isLowRiskPlan: vi.fn() }));
vi.mock("./investigationFlow.js", () => ({ investigateScope: vi.fn() }));
vi.mock("./scopeJudge.js", () => ({ runScopeJudge: vi.fn() }));
vi.mock("./revisionApprovals.js", () => ({ requestRevisionApproval: vi.fn() }));

import { runAuditPipeline } from "./auditPipeline.js";
import { shouldRunAudit, isLowRiskPlan } from "./auditMode.js";
import { investigateScope } from "./investigationFlow.js";
import { runScopeJudge } from "./scopeJudge.js";
import { requestRevisionApproval } from "./revisionApprovals.js";

const FAKE_PLAN = {
  objective: "Refactor auth module",
  steps: [
    { title: "Read auth files", filesLikely: [] as string[], subagentEligible: false },
    { title: "Apply changes", filesLikely: [] as string[], subagentEligible: false },
  ],
};

const BASE_INPUT = {
  task: "Refactor auth",
  repoPath: "/tmp/repo",
  runId: "run-test-1",
  tier: "medium" as const,
  auditMode: "auto" as const,
  forceAudit: false,
  emit: vi.fn(),
};

function makeNoMismatchJudgement() {
  return { type: "none" as const, severity: "none" as const, mismatch: false, reason: "", revisedPlan: null };
}

function makeMismatchJudgement() {
  return {
    type: "over_scope" as const,
    severity: "major" as const,
    mismatch: true,
    reason: "Too many files",
    revisedPlan: "Revised plan text",
    missingFiles: undefined,
    unnecessaryFiles: undefined,
  };
}

function makeInvestigateResult(overrides = {}) {
  return {
    findings: "All looks good",
    citations: [],
    toolCallCount: 2,
    costUsd: 0.01,
    skipped: false as boolean,
    skipReason: undefined,
    agentSuggestedRevision: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(isLowRiskPlan).mockReturnValue(false);
  vi.mocked(shouldRunAudit).mockReturnValue({ shouldRun: false as const, reason: "auto_mode" });
});

describe("runAuditPipeline", () => {
  it("1: shouldRun:false → returns {} with no findings", async () => {
    vi.mocked(shouldRunAudit).mockReturnValue({ shouldRun: false as const, reason: "auto_mode" });
    const result = await runAuditPipeline({ ...BASE_INPUT, preGeneratedPlan: FAKE_PLAN });
    expect(result).toEqual({});
    expect(vi.mocked(investigateScope)).not.toHaveBeenCalled();
  });

  it("2: shouldRun:true + no preGeneratedPlan → returns {} (no_plan skip)", async () => {
    vi.mocked(shouldRunAudit).mockReturnValue({ shouldRun: true as const, reason: "explicit_request" });
    const result = await runAuditPipeline({ ...BASE_INPUT, preGeneratedPlan: undefined });
    expect(result).toEqual({});
    expect(vi.mocked(investigateScope)).not.toHaveBeenCalled();
  });

  it("3: shouldRun:true + plan + investigateScope skipped → no auditFindings and emits skip event", async () => {
    vi.mocked(shouldRunAudit).mockReturnValue({ shouldRun: true as const, reason: "explicit_request" });
    vi.mocked(investigateScope).mockResolvedValue(
      makeInvestigateResult({ skipped: true, skipReason: "insufficient_token_budget", findings: "", citations: [], toolCallCount: 0, costUsd: 0 })
    );
    const emit = vi.fn();
    const result = await runAuditPipeline({ ...BASE_INPUT, preGeneratedPlan: FAKE_PLAN, emit });
    expect(result.auditFindings).toBeUndefined();
    expect(result.revisionDecision).toBeUndefined();
    const emittedTypes = emit.mock.calls.map((c) => (c[0] as any).progress?.type);
    expect(emittedTypes).toContain("scope_audit_skipped");
  });

  it("4: shouldRun:true + plan + no mismatch → returns { auditFindings } with revisionDecision undefined", async () => {
    vi.mocked(shouldRunAudit).mockReturnValue({ shouldRun: true as const, reason: "explicit_request" });
    vi.mocked(investigateScope).mockResolvedValue(makeInvestigateResult());
    vi.mocked(runScopeJudge).mockResolvedValue(makeNoMismatchJudgement());
    const result = await runAuditPipeline({ ...BASE_INPUT, preGeneratedPlan: FAKE_PLAN });
    expect(result.auditFindings).toBeDefined();
    expect(result.auditFindings?.summary).toBe("All looks good");
    expect(result.revisionDecision).toBeUndefined();
    expect(result.earlyExit).toBeNull();
  });

  it("5: shouldRun:true + mismatch + approve → revisionDecision:'approve'", async () => {
    vi.mocked(shouldRunAudit).mockReturnValue({ shouldRun: true as const, reason: "explicit_request" });
    vi.mocked(investigateScope).mockResolvedValue(makeInvestigateResult());
    vi.mocked(runScopeJudge).mockResolvedValue(makeMismatchJudgement());
    vi.mocked(requestRevisionApproval).mockResolvedValue({ decision: "approve" as const, revisionId: "rev-1" });
    const result = await runAuditPipeline({ ...BASE_INPUT, preGeneratedPlan: FAKE_PLAN });
    expect(result.revisionDecision).toBe("approve");
    expect(result.auditFindings).toBeDefined();
    expect(result.earlyExit).toBeNull();
  });

  it("6: shouldRun:true + mismatch + reject → revisionDecision:'reject'", async () => {
    vi.mocked(shouldRunAudit).mockReturnValue({ shouldRun: true as const, reason: "explicit_request" });
    vi.mocked(investigateScope).mockResolvedValue(makeInvestigateResult());
    vi.mocked(runScopeJudge).mockResolvedValue(makeMismatchJudgement());
    vi.mocked(requestRevisionApproval).mockResolvedValue({ decision: "reject" as const, revisionId: "rev-1" });
    const result = await runAuditPipeline({ ...BASE_INPUT, preGeneratedPlan: FAKE_PLAN });
    expect(result.revisionDecision).toBe("reject");
    expect(result.earlyExit).toBeNull();
  });

  it("7: shouldRun:true + mismatch + timeout → earlyExit with terminationReason", async () => {
    vi.mocked(shouldRunAudit).mockReturnValue({ shouldRun: true as const, reason: "explicit_request" });
    vi.mocked(investigateScope).mockResolvedValue(makeInvestigateResult());
    vi.mocked(runScopeJudge).mockResolvedValue(makeMismatchJudgement());
    vi.mocked(requestRevisionApproval).mockResolvedValue({ decision: "timeout" as const, revisionId: "rev-1" });
    const result = await runAuditPipeline({ ...BASE_INPUT, preGeneratedPlan: FAKE_PLAN });
    expect(result.earlyExit?.terminationReason).toBe("revision_approval_timeout");
    expect(result.earlyExit?.revisionId).toBe("rev-1");
  });
});
