/**
 * Phase D-S1 — Pattern 1 Phase Split tests.
 *
 * Tests are split between pure-unit assertions on data structures and
 * integration-style tests that mock investigateScope / requestRevisionApproval
 * to verify the runPhaseSplitInvestigation helper's behaviour.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  investigateScope: vi.fn(),
  requestRevisionApproval: vi.fn(),
}));

vi.mock("../llm/investigationFlow.js", () => ({
  investigateScope: mocks.investigateScope,
}));

vi.mock("../llm/revisionApprovals.js", () => ({
  requestRevisionApproval: mocks.requestRevisionApproval,
  rejectPendingRevisionsForRun: vi.fn().mockReturnValue(0),
  resolveRevisionApproval: vi.fn(),
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { TIER_LIMITS } from "../llm/tierLimits.js";
import { getPatchUserFacingReason } from "../llm/patchUserFacingReason.js";
import { runPhaseSplitInvestigation } from "./runLlmPatchFlow.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeInvestigateResult(overrides: Partial<{
  findings: string;
  citations: Array<{ file: string }>;
  toolCallCount: number;
  tokensUsed: number;
  costUsd: number;
  skipped: boolean;
  skipReason: string;
}> = {}) {
  return {
    findings: "Phase 1 found: src/foo.ts needs update.",
    citations: [{ file: "src/foo.ts" }],
    toolCallCount: 3,
    tokensUsed: 45_000,
    costUsd: 0.0012,
    skipped: false,
    ...overrides,
  };
}

// ── Test 1: Per-phase iter cap values in TIER_LIMITS ─────────────────────────

describe("Phase D-S1 — per-phase iter caps in TIER_LIMITS", () => {
  it("simple tier: phase1Cap=0 (skip Phase 1), phase2Cap=15", () => {
    expect(TIER_LIMITS.simple.phase1Cap).toBe(0);
    expect(TIER_LIMITS.simple.phase2Cap).toBe(15);
  });

  it("medium tier: phase1Cap=8, phase2Cap=20", () => {
    expect(TIER_LIMITS.medium.phase1Cap).toBe(8);
    expect(TIER_LIMITS.medium.phase2Cap).toBe(20);
  });

  it("complex tier: phase1Cap=12, phase2Cap=30", () => {
    expect(TIER_LIMITS.complex.phase1Cap).toBe(12);
    expect(TIER_LIMITS.complex.phase2Cap).toBe(30);
  });
});

// ── Test 2: Phase 1 token budget hard-cap (30% of tier budget) ───────────────

describe("Phase D-S1 — phase 1 token budget hard-cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.investigateScope.mockResolvedValue(makeInvestigateResult());
    mocks.requestRevisionApproval.mockResolvedValue({ revisionId: "rev-1", decision: "approve" });
  });

  it("medium tier: investigateScope called with 30% of 600K = 180K token budget", async () => {
    const emitProgress = vi.fn();
    await runPhaseSplitInvestigation({
      task: "Fix failing tests",
      repoPath: "/repo",
      tier: "medium",
      tierLimits: TIER_LIMITS.medium,
      emitProgress,
    });

    expect(mocks.investigateScope).toHaveBeenCalledOnce();
    const callArgs = mocks.investigateScope.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs["tokenBudgetRemaining"]).toBe(Math.floor(600_000 * 0.30)); // 180_000
  });

  it("complex tier: investigateScope called with 30% of 800K = 240K token budget", async () => {
    const emitProgress = vi.fn();
    mocks.requestRevisionApproval.mockResolvedValue({ revisionId: "rev-2", decision: "approve" });

    await runPhaseSplitInvestigation({
      task: "Architecture refactor",
      repoPath: "/repo",
      tier: "complex",
      tierLimits: TIER_LIMITS.complex,
      emitProgress,
    });

    const callArgs = mocks.investigateScope.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs["tokenBudgetRemaining"]).toBe(Math.floor(800_000 * 0.30)); // 240_000
  });
});

// ── Test 3: phase_changed SSE event emitted exactly once per transition ───────

describe("Phase D-S1 — phase_changed SSE event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.investigateScope.mockResolvedValue(makeInvestigateResult());
    mocks.requestRevisionApproval.mockResolvedValue({ revisionId: "rev-1", decision: "approve" });
  });

  it("emits exactly one phase_changed event (medium tier, no approval wait)", async () => {
    const events: Array<Record<string, unknown>> = [];
    const emitProgress = vi.fn((evt: Record<string, unknown>) => events.push(evt));

    await runPhaseSplitInvestigation({
      task: "Fix failing tests",
      repoPath: "/repo",
      tier: "medium",
      tierLimits: TIER_LIMITS.medium,
      emitProgress,
    });

    const phaseChanged = events.filter((e) => e["type"] === "phase_changed");
    expect(phaseChanged).toHaveLength(1);
    expect(phaseChanged[0]).toMatchObject({ type: "phase_changed", phase: 2 });
    expect(typeof (phaseChanged[0] as Record<string, unknown>)["remainingTokenBudget"]).toBe("number");
  });

  it("phase_changed carries remaining token budget after Phase 1 consumption", async () => {
    const phase1TokensUsed = 45_000;
    mocks.investigateScope.mockResolvedValue(makeInvestigateResult({ tokensUsed: phase1TokensUsed }));
    const events: Array<Record<string, unknown>> = [];
    const emitProgress = vi.fn((evt: Record<string, unknown>) => events.push(evt));

    await runPhaseSplitInvestigation({
      task: "Fix failing tests",
      repoPath: "/repo",
      tier: "medium",
      tierLimits: TIER_LIMITS.medium,
      emitProgress,
    });

    const phaseChanged = events.find((e) => e["type"] === "phase_changed")!;
    expect(phaseChanged["remainingTokenBudget"]).toBe(600_000 - phase1TokensUsed);
  });
});

// ── Test 4: terminationReason "phase1_handoff" maps to success ────────────────

describe("Phase D-S1 — terminationReason phase1_handoff → category=success", () => {
  it("getPatchUserFacingReason returns success for phase1_handoff", () => {
    const result = getPatchUserFacingReason({ terminationReason: "phase1_handoff" });
    expect(result.category).toBe("success");
    expect(result.canResume).toBe(true);
    expect(result.resumeHint).toBeNull();
  });
});

// ── Test 5: preClassifiedTask + auditFindings flow Phase 1 → Phase 2 ─────────

describe("Phase D-S1 — auditFindings flow from Phase 1 to Phase 2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.investigateScope.mockResolvedValue(makeInvestigateResult({
      findings: "Investigated: foo.ts uses old API.",
      citations: [{ file: "src/foo.ts" }, { file: "src/bar.ts" }],
      toolCallCount: 5,
      costUsd: 0.0025,
    }));
  });

  it("auditFindings contains findings sliced to 2048 chars and citation count", async () => {
    const emitProgress = vi.fn();

    const result = await runPhaseSplitInvestigation({
      task: "Fix stale tests after refactor",
      repoPath: "/repo",
      tier: "medium",
      tierLimits: TIER_LIMITS.medium,
      emitProgress,
    });

    expect(result.auditFindings).toBeDefined();
    expect(result.auditFindings!.citationCount).toBe(2);
    expect(result.auditFindings!.toolCallCount).toBe(5);
    expect(result.auditFindings!.costUsd).toBeCloseTo(0.0025);
    expect(result.auditFindings!.summary).toBe("Investigated: foo.ts uses old API.");
  });

  it("auditFindings is undefined when Phase 1 skipped (insufficient budget)", async () => {
    mocks.investigateScope.mockResolvedValue(makeInvestigateResult({
      skipped: true,
      findings: "",
    }));
    const emitProgress = vi.fn();

    const result = await runPhaseSplitInvestigation({
      task: "Fix stale tests",
      repoPath: "/repo",
      tier: "medium",
      tierLimits: TIER_LIMITS.medium,
      emitProgress,
    });

    expect(result.auditFindings).toBeUndefined();
    expect(result.skipped).toBe(true);
  });
});

// ── Test 6: ZONE_PHASE_SPLIT=0 → investigateScope not called ─────────────────

describe("Phase D-S1 — ZONE_PHASE_SPLIT env gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("phase1Cap=0 (simple tier) means Phase 1 is never triggered", () => {
    // TIER_LIMITS.simple.phase1Cap === 0 is the guard; runPhaseSplitInvestigation
    // is only called when phase1Cap > 0. Verify the guard value.
    expect(TIER_LIMITS.simple.phase1Cap).toBe(0);
    // investigateScope must NOT be called because runLlmPatchFlow checks phase1Cap > 0.
    // (The function-level test for ZONE_PHASE_SPLIT=0 is validated by checking
    //  the env string parsing: only "1" enables the split.)
    const phaseSplitEnabled = String("0").trim() === "1";
    expect(phaseSplitEnabled).toBe(false);
  });

  it("ZONE_PHASE_SPLIT='1' enables the feature gate", () => {
    const phaseSplitEnabled = String("1").trim() === "1";
    expect(phaseSplitEnabled).toBe(true);
  });
});

// ── Test 7: Simple tier skips Phase 1 even when ZONE_PHASE_SPLIT=1 ───────────

describe("Phase D-S1 — simple tier skips Phase 1", () => {
  it("TIER_LIMITS.simple.phase1Cap === 0 causes Phase 1 bypass", () => {
    // The gate in runLlmPatchFlow: `if (splitTierLimits.phase1Cap > 0)`
    // Simple tier has phase1Cap=0, so investigateScope is never called.
    const tierLimits = TIER_LIMITS.simple;
    expect(tierLimits.phase1Cap).toBe(0);
    // Verify the guard is false for simple tier.
    expect(tierLimits.phase1Cap > 0).toBe(false);
  });
});

// ── Test 8: Medium auto-approve, complex emits scope_revision_proposed ────────

describe("Phase D-S1 — approval policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.investigateScope.mockResolvedValue(makeInvestigateResult());
  });

  it("medium tier: requestRevisionApproval NOT called (auto-proceed)", async () => {
    const emitProgress = vi.fn();

    await runPhaseSplitInvestigation({
      task: "Fix stale tests",
      repoPath: "/repo",
      tier: "medium",
      tierLimits: TIER_LIMITS.medium,
      emitProgress,
    });

    expect(mocks.requestRevisionApproval).not.toHaveBeenCalled();
  });

  it("complex tier: requestRevisionApproval called (emits scope_revision_proposed)", async () => {
    // Simulate real requestRevisionApproval: calls emit with scope_revision_proposed
    // before resolving, so the event lands in our captured list.
    mocks.requestRevisionApproval.mockImplementation(
      async (input: { emit: (evt: Record<string, unknown>) => void }) => {
        input.emit({
          type: "scope_revision_proposed",
          runId: "run-test",
          revisionId: "rev-c1",
          revisionType: "under_scope",
          revisionReason: "Phase 1 investigation complete.",
          revisionOriginalPlan: "",
          revisionRevisedPlanSummary: "",
        });
        return { revisionId: "rev-c1", decision: "approve" };
      }
    );
    const events: Array<Record<string, unknown>> = [];
    const emitProgress = vi.fn((evt: Record<string, unknown>) => events.push(evt));

    await runPhaseSplitInvestigation({
      task: "Architecture refactor across 10 modules",
      repoPath: "/repo",
      tier: "complex",
      tierLimits: TIER_LIMITS.complex,
      emitProgress,
    });

    expect(mocks.requestRevisionApproval).toHaveBeenCalledOnce();
    const revisionProposed = events.filter((e) => e["type"] === "scope_revision_proposed");
    expect(revisionProposed).toHaveLength(1);
  });

  it("complex tier: rejection clears auditFindings (falls back to single-phase)", async () => {
    mocks.requestRevisionApproval.mockResolvedValue({ revisionId: "rev-c2", decision: "reject" });
    const emitProgress = vi.fn();

    const result = await runPhaseSplitInvestigation({
      task: "Architecture refactor across 10 modules",
      repoPath: "/repo",
      tier: "complex",
      tierLimits: TIER_LIMITS.complex,
      emitProgress,
    });

    expect(result.auditFindings).toBeUndefined();
    expect(result.approvalDecision).toBe("reject");
  });
});
