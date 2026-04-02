import { describe, expect, it } from "vitest";
import { buildDecisionTrace } from "./buildDecisionTrace.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const emptyBreakdown = {
  base: 100,
  destructivePenalty: 0,
  schemaPenalty: 0,
  criticalPenalty: 0,
  massScopePenalty: 0,
  lowRiskBonus: 0
};

// ─── Core Fields ────────────────────────────────────────────────────────────

describe("buildDecisionTrace – core fields", () => {
  it("copies raw signals as-is", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive", "mass_scope"],
      riskScore: 75,
      confidenceScore: 25,
      mode: "blocked",
      confidenceBreakdown: {
        ...emptyBreakdown,
        destructivePenalty: -50,
        massScopePenalty: -25
      }
    });

    expect(trace.signals).toEqual(["destructive", "mass_scope"]);
  });

  it("copies score fields exactly", () => {
    const trace = buildDecisionTrace({
      signals: ["schema"],
      riskScore: 25,
      confidenceScore: 75,
      mode: "preview_only",
      confidenceBreakdown: {
        ...emptyBreakdown,
        schemaPenalty: -25
      }
    });

    expect(trace.riskScore).toBe(25);
    expect(trace.confidenceScore).toBe(75);
  });
});

// ─── Normalized Signals ─────────────────────────────────────────────────────

describe("buildDecisionTrace – normalizedSignals", () => {
  it("builds normalizedSignals from raw signals", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive", "mass_scope"],
      riskScore: 75,
      confidenceScore: 25,
      mode: "blocked",
      confidenceBreakdown: {
        ...emptyBreakdown,
        destructivePenalty: -50,
        massScopePenalty: -25
      }
    });

    expect(trace.normalizedSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "destructive",
          severity: "high",
          confidenceImpact: -50,
          label: "Potentially destructive change"
        }),
        expect.objectContaining({
          type: "mass_scope",
          severity: "high",
          confidenceImpact: -25,
          label: "Mass-scope operation"
        })
      ])
    );
  });

  it("normalizes schema signal correctly", () => {
    const trace = buildDecisionTrace({
      signals: ["schema"],
      riskScore: 25,
      confidenceScore: 75,
      mode: "preview_only",
      confidenceBreakdown: {
        ...emptyBreakdown,
        schemaPenalty: -25
      }
    });

    expect(trace.normalizedSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "schema",
          severity: "medium"
        })
      ])
    );
  });

  it("returns empty normalizedSignals for empty signals array", () => {
    const trace = buildDecisionTrace({
      signals: [],
      riskScore: 0,
      confidenceScore: 100,
      mode: "safe_to_apply",
      confidenceBreakdown: emptyBreakdown
    });

    expect(trace.normalizedSignals).toEqual([]);
  });
});

// ─── Applied Penalties ───────────────────────────────────────────────────────

describe("buildDecisionTrace – appliedPenalties", () => {
  it("includes all active penalties", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive", "schema", "mass_scope"],
      riskScore: 100,
      confidenceScore: 0,
      mode: "blocked",
      confidenceBreakdown: {
        ...emptyBreakdown,
        destructivePenalty: -50,
        schemaPenalty: -25,
        massScopePenalty: -25
      }
    });

    expect(trace.appliedPenalties).toEqual([
      { type: "destructive", impact: -50 },
      { type: "schema", impact: -25 },
      { type: "mass_scope", impact: -25 }
    ]);
  });

  it("includes critical_domain penalty when present", () => {
    const trace = buildDecisionTrace({
      signals: ["critical_domain"],
      riskScore: 40,
      confidenceScore: 60,
      mode: "preview_only",
      confidenceBreakdown: {
        ...emptyBreakdown,
        criticalPenalty: -20
      }
    });

    expect(trace.appliedPenalties).toEqual([
      { type: "critical_domain", impact: -20 }
    ]);
  });

  it("returns empty appliedPenalties when no penalties exist", () => {
    const trace = buildDecisionTrace({
      signals: ["low_risk"],
      riskScore: 0,
      confidenceScore: 100,
      mode: "safe_to_apply",
      confidenceBreakdown: {
        ...emptyBreakdown,
        lowRiskBonus: 10
      }
    });

    expect(trace.appliedPenalties).toEqual([]);
  });

  it("skips zero-value penalties", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive"],
      riskScore: 50,
      confidenceScore: 50,
      mode: "blocked",
      confidenceBreakdown: {
        ...emptyBreakdown,
        destructivePenalty: -50,
        schemaPenalty: 0
      }
    });

    const types = trace.appliedPenalties.map((p) => p.type);
    expect(types).not.toContain("schema");
    expect(types).toContain("destructive");
  });
});

// ─── Decision Path ───────────────────────────────────────────────────────────

describe("buildDecisionTrace – decisionPath", () => {
  it("starts with detected signals in order", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive", "mass_scope"],
      riskScore: 75,
      confidenceScore: 25,
      mode: "blocked",
      confidenceBreakdown: {
        ...emptyBreakdown,
        destructivePenalty: -50,
        massScopePenalty: -25
      }
    });

    expect(trace.decisionPath[0]).toBe("Detected destructive signal");
    expect(trace.decisionPath[1]).toBe("Detected mass_scope signal");
  });

  it("includes applied penalties after signals", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive", "schema"],
      riskScore: 75,
      confidenceScore: 25,
      mode: "blocked",
      confidenceBreakdown: {
        ...emptyBreakdown,
        destructivePenalty: -50,
        schemaPenalty: -25
      }
    });

    expect(trace.decisionPath).toContain("Applied destructive penalty: -50");
    expect(trace.decisionPath).toContain("Applied schema penalty: -25");
  });

  it("ends with risk score then mode", () => {
    const trace = buildDecisionTrace({
      signals: ["low_risk"],
      riskScore: 0,
      confidenceScore: 100,
      mode: "safe_to_apply",
      confidenceBreakdown: {
        ...emptyBreakdown,
        lowRiskBonus: 10
      }
    });

    expect(trace.decisionPath.at(-2)).toBe("Total risk score: 0");
    expect(trace.decisionPath.at(-1)).toBe("Mapped to SAFE_TO_APPLY mode");
  });

  it("produces correct full path for blocked decision", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive", "mass_scope"],
      riskScore: 75,
      confidenceScore: 25,
      mode: "blocked",
      confidenceBreakdown: {
        ...emptyBreakdown,
        destructivePenalty: -50,
        massScopePenalty: -25
      }
    });

    expect(trace.decisionPath).toEqual([
      "Detected destructive signal",
      "Detected mass_scope signal",
      "Applied destructive penalty: -50",
      "Applied mass_scope penalty: -25",
      "Total risk score: 75",
      "Mapped to BLOCKED mode"
    ]);
  });

  it("produces correct full path for preview_only decision", () => {
    const trace = buildDecisionTrace({
      signals: ["schema"],
      riskScore: 25,
      confidenceScore: 75,
      mode: "preview_only",
      confidenceBreakdown: {
        ...emptyBreakdown,
        schemaPenalty: -25
      }
    });

    expect(trace.decisionPath).toEqual([
      "Detected schema signal",
      "Applied schema penalty: -25",
      "Total risk score: 25",
      "Mapped to PREVIEW_ONLY mode"
    ]);
  });

  it("produces correct full path for safe_to_apply decision", () => {
    const trace = buildDecisionTrace({
      signals: ["low_risk"],
      riskScore: 0,
      confidenceScore: 100,
      mode: "safe_to_apply",
      confidenceBreakdown: {
        ...emptyBreakdown,
        lowRiskBonus: 10
      }
    });

    expect(trace.decisionPath).toEqual([
      "Detected low_risk signal",
      "Total risk score: 0",
      "Mapped to SAFE_TO_APPLY mode"
    ]);
  });

  it("skips Applied steps entirely when no penalties", () => {
    const trace = buildDecisionTrace({
      signals: ["low_risk"],
      riskScore: 0,
      confidenceScore: 100,
      mode: "safe_to_apply",
      confidenceBreakdown: emptyBreakdown
    });

    const hasApplied = trace.decisionPath.some((step) =>
      step.startsWith("Applied")
    );
    expect(hasApplied).toBe(false);
  });

  it("handles empty signals array gracefully", () => {
    const trace = buildDecisionTrace({
      signals: [],
      riskScore: 0,
      confidenceScore: 100,
      mode: "safe_to_apply",
      confidenceBreakdown: emptyBreakdown
    });

    expect(trace.decisionPath).toEqual([
      "Total risk score: 0",
      "Mapped to SAFE_TO_APPLY mode"
    ]);
  });
});

describe("buildDecisionTrace – decisionFactors", () => {
  it("sets riskThreshold 71 for blocked mode", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive"],
      riskScore: 75,
      confidenceScore: 25,
      mode: "blocked",
      confidenceBreakdown: emptyBreakdown
    });

    expect(trace.decisionFactors.riskThreshold).toBe(71);
  });

  it("sets riskThreshold 31 for preview_only mode", () => {
    const trace = buildDecisionTrace({
      signals: ["schema"],
      riskScore: 35,
      confidenceScore: 65,
      mode: "preview_only",
      confidenceBreakdown: emptyBreakdown
    });

    expect(trace.decisionFactors.riskThreshold).toBe(31);
  });

  it("sets riskThreshold 0 for safe_to_apply mode", () => {
    const trace = buildDecisionTrace({
      signals: ["low_risk"],
      riskScore: 0,
      confidenceScore: 100,
      mode: "safe_to_apply",
      confidenceBreakdown: emptyBreakdown
    });

    expect(trace.decisionFactors.riskThreshold).toBe(0);
  });

  it("triggeredBy includes riskScore when score >= 71", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive", "schema"],
      riskScore: 75,
      confidenceScore: 25,
      mode: "blocked",
      confidenceBreakdown: emptyBreakdown
    });

    expect(trace.decisionFactors.triggeredBy).toEqual(["riskScore"]);
  });

  it("triggeredBy includes signal names when score < 71 but signals force preview", () => {
    const trace = buildDecisionTrace({
      signals: ["schema", "mass_scope"],
      riskScore: 50,
      confidenceScore: 50,
      mode: "preview_only",
      confidenceBreakdown: emptyBreakdown
    });

    expect(trace.decisionFactors.triggeredBy).toContain("schema");
    expect(trace.decisionFactors.triggeredBy).toContain("mass_scope");
    expect(trace.decisionFactors.triggeredBy).not.toContain("riskScore");
  });

  it("triggeredBy is empty for safe_to_apply", () => {
    const trace = buildDecisionTrace({
      signals: ["low_risk"],
      riskScore: 0,
      confidenceScore: 100,
      mode: "safe_to_apply",
      confidenceBreakdown: emptyBreakdown
    });

    expect(trace.decisionFactors.triggeredBy).toEqual([]);
  });
});

describe("buildDecisionTrace – confidenceFormula", () => {
  it("shows only base when no penalties or bonuses", () => {
    const trace = buildDecisionTrace({
      signals: [],
      riskScore: 0,
      confidenceScore: 100,
      mode: "safe_to_apply",
      confidenceBreakdown: emptyBreakdown
    });

    expect(trace.confidenceFormula).toBe("100 = 100");
  });

  it("shows single destructive penalty", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive"],
      riskScore: 50,
      confidenceScore: 50,
      mode: "preview_only",
      confidenceBreakdown: {
        ...emptyBreakdown,
        destructivePenalty: -50
      }
    });

    expect(trace.confidenceFormula).toBe("100 - 50 (destructive) = 50");
  });

  it("shows multiple penalties combined", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive", "schema"],
      riskScore: 75,
      confidenceScore: 25,
      mode: "blocked",
      confidenceBreakdown: {
        ...emptyBreakdown,
        destructivePenalty: -50,
        schemaPenalty: -25
      }
    });

    expect(trace.confidenceFormula).toBe("100 - 50 (destructive) - 25 (schema) = 25");
  });

  it("shows low-risk bonus with plus sign", () => {
    const trace = buildDecisionTrace({
      signals: ["low_risk"],
      riskScore: 0,
      confidenceScore: 110,
      mode: "safe_to_apply",
      confidenceBreakdown: {
        ...emptyBreakdown,
        lowRiskBonus: 10
      }
    });

    expect(trace.confidenceFormula).toBe("100 + 10 (low-risk bonus) = 110");
  });

  it("shows all penalty types in correct order", () => {
    const trace = buildDecisionTrace({
      signals: ["destructive", "schema", "critical_domain", "mass_scope"],
      riskScore: 100,
      confidenceScore: 0,
      mode: "blocked",
      confidenceBreakdown: {
        base: 100,
        destructivePenalty: -40,
        schemaPenalty: -20,
        criticalPenalty: -20,
        massScopePenalty: -20,
        lowRiskBonus: 0
      }
    });

    expect(trace.confidenceFormula).toBe(
      "100 - 40 (destructive) - 20 (schema) - 20 (critical) - 20 (mass-scope) = 0"
    );
  });

  it("result equals base plus all values summed", () => {
    const breakdown = {
      base: 100,
      destructivePenalty: -50,
      schemaPenalty: -25,
      criticalPenalty: -10,
      massScopePenalty: -5,
      lowRiskBonus: 0
    };
    const trace = buildDecisionTrace({
      signals: ["destructive", "schema", "critical_domain", "mass_scope"],
      riskScore: 90,
      confidenceScore: 10,
      mode: "blocked",
      confidenceBreakdown: breakdown
    });

    const expectedResult =
      breakdown.base +
      breakdown.destructivePenalty +
      breakdown.schemaPenalty +
      breakdown.criticalPenalty +
      breakdown.massScopePenalty +
      breakdown.lowRiskBonus;

    expect(trace.confidenceFormula).toContain(`= ${expectedResult}`);
  });
  it("includes reasonMapping when reason details are provided", () => {
  const trace = buildDecisionTrace({
    signals: ["schema"],
    riskScore: 40,
    confidenceScore: 75,
    confidenceBreakdown: {
      base: 100,
      destructivePenalty: 0,
      schemaPenalty: -25,
      criticalPenalty: 0,
      massScopePenalty: 0,
      lowRiskBonus: 0
    },
    mode: "preview_only",
    reasonDetails: [
      {
        code: "PREVIEW_SCHEMA_RISK",
        severity: "warning",
        category: "risk",
        message: "Schema-sensitive changes require preview."
      }
    ]
  });

  expect(trace.reasonMapping).toEqual([
    {
      code: "PREVIEW_SCHEMA_RISK",
      severity: "warning",
      category: "risk",
      message: "Schema-sensitive changes require preview."
    }
  ]);
});
  it("returns empty reasonMapping when reason details are omitted", () => {
  const trace = buildDecisionTrace({
    signals: [],
    riskScore: 0,
    confidenceScore: 100,
    confidenceBreakdown: {
      base: 100,
      destructivePenalty: 0,
      schemaPenalty: 0,
      criticalPenalty: 0,
      massScopePenalty: 0,
      lowRiskBonus: 0
    },
    mode: "safe_to_apply"
  });

  expect(trace.reasonMapping).toEqual([]);
});
});