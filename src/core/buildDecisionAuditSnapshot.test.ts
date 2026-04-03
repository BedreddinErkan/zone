import { describe, expect, it } from "vitest";
import { buildDecisionAuditSnapshot } from "./buildDecisionAuditSnapshot.js";

describe("buildDecisionAuditSnapshot", () => {
  it("builds a deterministic audit snapshot from runAgent-style output", () => {
    const result = {
      task: "drop users table",
      decision: {
        mode: "blocked" as const,
        confidenceScore: 25
      },
      risk: {
        score: 75,
        breakdown: {
          destructive: 50,
          schema: 25,
          critical: 0,
          lowRisk: 0,
          massScope: 0
        }
      },
      confidence: {
        score: 25,
        breakdown: {
          base: 100,
          destructivePenalty: -50,
          schemaPenalty: -25,
          criticalPenalty: 0,
          massScopePenalty: 0,
          lowRiskBonus: 0
        }
      },
      explanation:
        "BLOCKED: Risk score 75/100 (destructive + schema signals detected)",
      recommendation:
        "Do not auto-apply. Manual review is required before making changes.",
      topRisks: [
        {
          title: "Potentially destructive change",
          severity: "high" as const,
          reason:
            "Task contains destructive keywords that may cause irreversible data loss."
        },
        {
          title: "Schema-sensitive change",
          severity: "medium" as const,
          reason: "Task may impact schema stability."
        }
      ],
      trace: {
        signals: ["destructive", "schema"],
        normalizedSignals: [
          {
            type: "destructive",
            severity: "high",
            confidenceImpact: -50,
            label: "Potentially destructive change"
          },
          {
            type: "schema",
            severity: "medium",
            confidenceImpact: -25,
            label: "Schema-sensitive change"
          }
        ],
        riskScore: 75,
        confidenceScore: 25,
        appliedPenalties: [
          {
            type: "destructive",
            impact: -50
          },
          {
            type: "schema",
            impact: -25
          }
        ],
        decisionPath: [
          "Detected destructive signal",
          "Detected schema signal",
          "Mapped to BLOCKED mode"
        ],
        decisionFactors: {
          riskThreshold: 71,
          triggeredBy: ["riskScore"]
        },
        confidenceFormula: "100 - 50 (destructive) - 25 (schema) = 25",
        reasonMapping: []
      },
      reasonCodes: [
        "BLOCKED_DESTRUCTIVE_OPERATION",
        "BLOCKED_SCHEMA_RISK",
        "BLOCKED_HIGH_RISK_SCORE"
      ] as const
    };

    const snapshot = buildDecisionAuditSnapshot(result);

    expect(snapshot.mode).toBe("blocked");
    expect(snapshot.confidenceScore).toBe(25);
    expect(snapshot.riskScore).toBe(75);

    expect(snapshot.reasonCodes).toEqual([
      "BLOCKED_DESTRUCTIVE_OPERATION",
      "BLOCKED_SCHEMA_RISK",
      "BLOCKED_HIGH_RISK_SCORE"
    ]);

    expect(snapshot.reasonDetails).toHaveLength(3);
    expect(snapshot.reasonDetails[0]).toEqual(
      expect.objectContaining({
        code: expect.any(String),
        label: expect.any(String),
        summary: expect.any(String),
        severity: expect.any(String),
        category: expect.any(String)
      })
    );

    expect(snapshot.triggeredBy).toEqual(["riskScore"]);
    expect(snapshot.confidenceFormula).toBe(
      "100 - 50 (destructive) - 25 (schema) = 25"
    );

    expect(snapshot.topRiskSummaries).toEqual([
      "[high] Potentially destructive change",
      "[medium] Schema-sensitive change"
    ]);
  });

  it("returns empty derived arrays when reasonCodes and topRisks are absent or empty", () => {
    const result = {
      decision: {
        mode: "safe_to_apply" as const,
        confidenceScore: 91
      },
      risk: {
        score: 10,
        breakdown: {
          destructive: 0,
          schema: 0,
          critical: 0,
          lowRisk: 10,
          massScope: 0
        }
      },
      topRisks: [],
      trace: {
        signals: [],
        normalizedSignals: [],
        riskScore: 10,
        confidenceScore: 91,
        appliedPenalties: [],
        decisionPath: ["Low-risk localized task"],
        decisionFactors: {
          riskThreshold: 71,
          triggeredBy: []
        },
        confidenceFormula: "100 + 0 = 100",
        reasonMapping: []
      },
      reasonCodes: [] as const
    };

    const snapshot = buildDecisionAuditSnapshot(result);

    expect(snapshot.mode).toBe("safe_to_apply");
    expect(snapshot.confidenceScore).toBe(91);
    expect(snapshot.riskScore).toBe(10);
    expect(snapshot.reasonCodes).toEqual([]);
    expect(snapshot.reasonDetails).toEqual([]);
    expect(snapshot.triggeredBy).toEqual([]);
    expect(snapshot.confidenceFormula).toBe("100 + 0 = 100");
    expect(snapshot.topRiskSummaries).toEqual([]);
  });

  it("gracefully falls back when trace is missing", () => {
    const result = {
      decision: {
        mode: "preview_only" as const,
        confidenceScore: 55,

      },
      risk: {
        score: 45,
        breakdown: {
          destructive: 0,
          schema: 25,
          critical: 20,
          lowRisk: 0,
          massScope: 0
        }
      },
      topRisks: [
        {
          title: "Critical area change",
          severity: "medium" as const,
          reason: "Touches a critical domain."
        }
      ],
reasonCodes: ["PREVIEW_CRITICAL_SIGNAL"] as const    };

    const snapshot = buildDecisionAuditSnapshot(result);

    expect(snapshot.mode).toBe("preview_only");
    expect(snapshot.confidenceScore).toBe(55);
    expect(snapshot.riskScore).toBe(45);
expect(snapshot.reasonCodes).toEqual(["PREVIEW_CRITICAL_SIGNAL"]);    expect(snapshot.reasonDetails).toHaveLength(1);
    expect(snapshot.triggeredBy).toEqual([]);
    expect(snapshot.confidenceFormula).toBe("");
    expect(snapshot.topRiskSummaries).toEqual([
      "[medium] Critical area change"
    ]);
  });
});