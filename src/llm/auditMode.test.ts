import { describe, expect, it } from "vitest";
import { DEFAULT_AUDIT_MODE, isLowRiskPlan, shouldRunAudit } from "./auditMode.js";
import type { ExecutionPlan } from "./executionPlan.js";
import type { TaskClassification } from "./taskClassifier.js";

describe("shouldRunAudit", () => {
  describe("auditMode=auto", () => {
    it("skips audit for tier=simple", () => {
      const r = shouldRunAudit({ tier: "simple", auditMode: "auto" });
      expect(r.shouldRun).toBe(false);
      expect(r.reason).toContain("auto");
      expect(r.reason).toContain("simple");
    });

    it("runs audit for tier=medium", () => {
      const r = shouldRunAudit({ tier: "medium", auditMode: "auto" });
      expect(r.shouldRun).toBe(true);
      expect(r.reason).toContain("medium");
    });

    it("runs audit for tier=complex", () => {
      const r = shouldRunAudit({ tier: "complex", auditMode: "auto" });
      expect(r.shouldRun).toBe(true);
      expect(r.reason).toContain("complex");
    });
  });

  describe("auditMode=always", () => {
    it.each(["simple", "medium", "complex"] as const)(
      "runs audit for tier=%s",
      (tier) => {
        const r = shouldRunAudit({ tier, auditMode: "always" });
        expect(r.shouldRun).toBe(true);
        expect(r.reason).toContain("always");
      }
    );
  });

  describe("auditMode=on_demand", () => {
    it.each(["simple", "medium", "complex"] as const)(
      "skips audit for tier=%s without explicit request",
      (tier) => {
        const r = shouldRunAudit({ tier, auditMode: "on_demand" });
        expect(r.shouldRun).toBe(false);
        expect(r.reason).toContain("on_demand");
      }
    );

    it("runs audit on explicit request even in on_demand mode", () => {
      const r = shouldRunAudit({ tier: "simple", auditMode: "on_demand", explicitRequest: true });
      expect(r.shouldRun).toBe(true);
      expect(r.reason).toContain("explicit");
    });
  });

  describe("explicit request override", () => {
    it("forces audit in auto mode for simple tier", () => {
      const r = shouldRunAudit({ tier: "simple", auditMode: "auto", explicitRequest: true });
      expect(r.shouldRun).toBe(true);
    });

    it("forces audit in always mode for all tiers (redundant but consistent)", () => {
      const r = shouldRunAudit({ tier: "complex", auditMode: "always", explicitRequest: true });
      expect(r.shouldRun).toBe(true);
    });
  });

  describe("DEFAULT_AUDIT_MODE", () => {
    it("default is auto", () => {
      expect(DEFAULT_AUDIT_MODE).toBe("auto");
    });
  });
});

// ---------------------------------------------------------------------------
// isLowRiskPlan + shouldRunAudit low-risk skip (Phase O cost-opt)
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    objective: "Add a log line to server startup",
    steps: [
      {
        title: "Edit server.ts",
        description: "Add console.log at startup",
        filesLikely: ["src/api/server.ts"],
        subagentEligible: false,
      },
    ],
    riskHints: [],
    scopeSummary: "Single file edit, no cross-cutting concerns.",
    ...overrides,
  };
}

function makeClassification(overrides: Partial<TaskClassification> = {}): TaskClassification {
  return {
    tier: "medium",
    estimatedFiles: 1,
    estimatedIterations: 8,
    confidence: 0.9,
    reasoning: "single file change",
    classifierCostUsd: 0.0001,
    classifierLatencyMs: 200,
    classifierModel: "claude-haiku-4-5",
    ...overrides,
  };
}

describe("isLowRiskPlan", () => {
  it("T.1 returns true for ≤2 file non-complex plan with no rename", () => {
    const plan = makePlan({
      steps: [
        { title: "Edit A", description: "d", filesLikely: ["src/a.ts"], subagentEligible: false },
        { title: "Edit B", description: "d", filesLikely: ["src/b.ts"], subagentEligible: false },
      ],
    });
    const cls = makeClassification({ tier: "medium" });
    expect(isLowRiskPlan(plan, cls)).toBe(true);
  });

  it("T.2 returns false for ≥4 file plan", () => {
    const plan = makePlan({
      steps: [
        {
          title: "Multi-file",
          description: "d",
          filesLikely: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
          subagentEligible: false,
        },
      ],
    });
    const cls = makeClassification({ tier: "medium" });
    expect(isLowRiskPlan(plan, cls)).toBe(false);
  });

  it("returns true for 3-file plan with mixed read/edit (run 25f18cb3 shape)", () => {
    // package.json read-only + server.ts edit + server.test.ts edit = 3 total.
    // Previously failed the ≤2 threshold; now passes at ≤3.
    const plan = makePlan({
      steps: [
        { title: "Read package.json", description: "check version", filesLikely: ["package.json"], subagentEligible: false },
        { title: "Edit server.ts", description: "add route", filesLikely: ["src/api/server.ts"], subagentEligible: false },
        { title: "Edit server.test.ts", description: "add test", filesLikely: ["src/api/server.test.ts"], subagentEligible: false },
      ],
    });
    const cls = makeClassification({ tier: "medium" });
    expect(isLowRiskPlan(plan, cls)).toBe(true);
  });

  it("T.3 returns false for tier=complex regardless of file count", () => {
    const plan = makePlan();
    const cls = makeClassification({ tier: "complex" });
    expect(isLowRiskPlan(plan, cls)).toBe(false);
  });

  it("returns false when a step is subagentEligible (fanout signal)", () => {
    const plan = makePlan({
      steps: [
        { title: "Edit A", description: "d", filesLikely: ["src/a.ts"], subagentEligible: true },
      ],
    });
    const cls = makeClassification({ tier: "medium" });
    expect(isLowRiskPlan(plan, cls)).toBe(false);
  });

  it("returns false when plan objective contains rename verb", () => {
    const plan = makePlan({ objective: "Rename the function foo to bar" });
    const cls = makeClassification({ tier: "medium" });
    expect(isLowRiskPlan(plan, cls)).toBe(false);
  });

  it("returns false when plan objective contains move verb", () => {
    const plan = makePlan({ objective: "Move auth logic from utils to middleware" });
    const cls = makeClassification({ tier: "medium" });
    expect(isLowRiskPlan(plan, cls)).toBe(false);
  });
});

describe("shouldRunAudit — low-risk plan skip (Phase O)", () => {
  it("T.4 shouldRunAudit returns false (skip) when isLowRiskPlan is true in auto mode", () => {
    const plan = makePlan();
    const cls = makeClassification({ tier: "medium" });
    const result = shouldRunAudit({
      tier: "medium",
      auditMode: "auto",
      plan,
      classification: cls,
    });
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe("low_risk_plan");
  });

  it("explicitRequest bypasses low-risk-plan skip", () => {
    const plan = makePlan();
    const cls = makeClassification({ tier: "medium" });
    const result = shouldRunAudit({
      tier: "medium",
      auditMode: "auto",
      plan,
      classification: cls,
      explicitRequest: true,
    });
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toContain("explicit");
  });

  it("auditMode=always bypasses low-risk-plan skip", () => {
    const plan = makePlan();
    const cls = makeClassification({ tier: "medium" });
    const result = shouldRunAudit({
      tier: "medium",
      auditMode: "always",
      plan,
      classification: cls,
    });
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toContain("always");
  });

  it("high-risk plan (4 files) still runs audit in auto mode", () => {
    const plan = makePlan({
      steps: [
        {
          title: "Multi-file",
          description: "d",
          filesLikely: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
          subagentEligible: false,
        },
      ],
    });
    const cls = makeClassification({ tier: "medium" });
    const result = shouldRunAudit({
      tier: "medium",
      auditMode: "auto",
      plan,
      classification: cls,
    });
    expect(result.shouldRun).toBe(true);
  });
});
