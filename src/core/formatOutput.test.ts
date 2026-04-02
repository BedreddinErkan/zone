import { describe, it, expect } from "vitest";
import { formatOutput } from "./formatOutput.js";

const mockResult = {
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
    "BLOCKED: Risk score 75/100 (destructive + schema signals detected)\nPrimary cause: destructive operation\nConfidence impact: destructive penalty: -50, schema penalty: -25",
  recommendation:
    "Do not auto-apply. Manual review is required before making changes.",
  topRisks: [
    {
      title: "Potentially destructive change",
      severity: "high" as const,
      reason:
        "Task contains destructive keywords that may cause irreversible data loss."
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
    decisionPath: [],
    decisionFactors: {
      riskThreshold: 71,
      triggeredBy: ["riskScore"]
    },
    confidenceFormula: "100 - 50 (destructive) - 25 (schema) = 25"
  },
  reasonCodes: [
    "BLOCKED_DESTRUCTIVE_OPERATION",
    "BLOCKED_SCHEMA_RISK",
    "BLOCKED_HIGH_RISK_SCORE"
  ]
};

describe("formatOutput - text", () => {
  it("returns CLI-style string containing SMILE AGENT header", () => {
    const output = formatOutput(mockResult, "text");
    expect(output).toContain("=== SMILE AGENT ===");
  });

  it("includes task and decision in output", () => {
    const output = formatOutput(mockResult, "text");
    expect(output).toContain("Task: drop users table");
    expect(output).toContain("Decision: blocked");
  });

  it("returns a non-empty string", () => {
    const output = formatOutput(mockResult, "text");
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });
});

describe("formatOutput - json", () => {
  it("returns a valid JSON string that can be parsed", () => {
    const output = formatOutput(mockResult, "json");
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("preserves top-level RunAgentResult fields", () => {
    const parsed = JSON.parse(formatOutput(mockResult, "json"));

    expect(parsed.task).toBe("drop users table");
    expect(parsed.explanation).toContain("BLOCKED");
    expect(parsed.recommendation).toBe(
      "Do not auto-apply. Manual review is required before making changes."
    );
  });

  it("preserves decision shape", () => {
    const parsed = JSON.parse(formatOutput(mockResult, "json"));

    expect(parsed.decision.mode).toBe("blocked");
    expect(parsed.decision.confidenceScore).toBe(25);
  });

  it("preserves risk breakdown shape", () => {
    const parsed = JSON.parse(formatOutput(mockResult, "json"));

    expect(parsed.risk.score).toBe(75);
    expect(parsed.risk.breakdown.destructive).toBe(50);
    expect(parsed.risk.breakdown.schema).toBe(25);
    expect(parsed.risk.breakdown.critical).toBe(0);
    expect(parsed.risk.breakdown.lowRisk).toBe(0);
    expect(parsed.risk.breakdown.massScope).toBe(0);
  });

  it("preserves confidence breakdown shape", () => {
    const parsed = JSON.parse(formatOutput(mockResult, "json"));

    expect(parsed.confidence.score).toBe(25);
    expect(parsed.confidence.breakdown.base).toBe(100);
    expect(parsed.confidence.breakdown.destructivePenalty).toBe(-50);
    expect(parsed.confidence.breakdown.schemaPenalty).toBe(-25);
    expect(parsed.confidence.breakdown.massScopePenalty).toBe(0);
  });

  it("preserves topRisks array with all fields", () => {
    const parsed = JSON.parse(formatOutput(mockResult, "json"));

    expect(parsed.topRisks).toHaveLength(1);
    expect(parsed.topRisks[0].title).toBe("Potentially destructive change");
    expect(parsed.topRisks[0].severity).toBe("high");
    expect(parsed.topRisks[0].reason).toContain("irreversible");
  });

  it("preserves reasonCodes array", () => {
    const parsed = JSON.parse(formatOutput(mockResult, "json", { verbose: true }));

    expect(parsed.reasonCodes).toEqual([
      "BLOCKED_DESTRUCTIVE_OPERATION",
      "BLOCKED_SCHEMA_RISK",
      "BLOCKED_HIGH_RISK_SCORE"
    ]);
  });
});

const mockResultWithPath = {
  ...mockResult,
  trace: {
    ...mockResult.trace,
    decisionPath: [
      "Detected destructive signal",
      "Applied destructive penalty: -50",
      "Total risk score: 75",
      "Mapped to BLOCKED mode"
    ]
  }
};

describe("formatOutput - trace options", () => {
  it("does not include trace in output by default", () => {
    const text = formatOutput(mockResult, "text");
    expect(text).not.toContain("Decision Trace");

    const json = formatOutput(mockResult, "json");
    const parsed = JSON.parse(json);
    expect(parsed.trace).toBeUndefined();
  });

  it("includes decisionPath in text output when showTrace is true", () => {
    const output = formatOutput(mockResultWithPath, "text", { showTrace: true });
    expect(output).toContain("--- Decision Trace ---");
    expect(output).toContain("→ Detected destructive signal");
    expect(output).toContain("→ Mapped to BLOCKED mode");
  });

  it("includes confidenceFormula in text output when showTrace is true", () => {
    const output = formatOutput(mockResultWithPath, "text", { showTrace: true });
    expect(output).toContain("Formula:");
    expect(output).toContain("100 - 50 (destructive) - 25 (schema) = 25");
  });

  it("includes trace in JSON output when showTrace is true", () => {
    const output = formatOutput(mockResult, "json", { showTrace: true });
    const parsed = JSON.parse(output);
    expect(parsed.trace).toBeDefined();
    expect(Array.isArray(parsed.trace.decisionPath)).toBe(true);
    expect(parsed.trace.confidenceFormula).toBeDefined();
  });

  it("verbose includes trace in JSON output", () => {
    const output = formatOutput(mockResult, "json", { verbose: true });
    const parsed = JSON.parse(output);
    expect(parsed.trace).toBeDefined();
    expect(parsed.trace.decisionFactors).toBeDefined();
  });

  it("text output without trace flag is unchanged", () => {
    const withoutTrace = formatOutput(mockResult, "text");
    const withTrace = formatOutput(mockResult, "text", { showTrace: false });

    expect(withoutTrace).toBe(withTrace);
    expect(withoutTrace).toContain("=== SMILE AGENT ===");
  });
  it("does not include reasonDetails in JSON output by default", () => {
  const output = formatOutput(mockResult, "json");
  const parsed = JSON.parse(output);

  expect(parsed.reasonCodes).toEqual([
    "BLOCKED_DESTRUCTIVE_OPERATION",
    "BLOCKED_SCHEMA_RISK",
    "BLOCKED_HIGH_RISK_SCORE"
  ]);
  expect(parsed.reasonDetails).toBeUndefined();
});

it("includes reasonDetails in JSON output when verbose is true", () => {
  const output = formatOutput(mockResult, "json", { verbose: true });
  const parsed = JSON.parse(output);

  expect(parsed.reasonDetails).toBeDefined();
  expect(Array.isArray(parsed.reasonDetails)).toBe(true);
  expect(parsed.reasonDetails).toHaveLength(3);

  expect(parsed.reasonDetails[0]).toHaveProperty("code");
  expect(parsed.reasonDetails[0]).toHaveProperty("label");
  expect(parsed.reasonDetails[0]).toHaveProperty("summary");
  expect(parsed.reasonDetails[0]).toHaveProperty("severity");
  expect(parsed.reasonDetails[0]).toHaveProperty("category");
});

it("includes trace but omits reasonDetails in JSON output when showTrace is true", () => {
  const output = formatOutput(mockResult, "json", { showTrace: true });
  const parsed = JSON.parse(output);

  expect(parsed.trace).toBeDefined();
  expect(parsed.reasonDetails).toBeUndefined();
  expect(parsed.auditSnapshot).toBeUndefined();
});
it("includes verbose reason details in text output when verbose is true", () => {
  const output = formatOutput(mockResult, "text", { verbose: true });

  expect(output).toContain("Reason Codes:");
  expect(output).toContain("Reason Details:");
  expect(output).toContain("code: BLOCKED_DESTRUCTIVE_OPERATION");
  expect(output).toContain("summary:");
});
it("keeps reasonCodes but omits reasonDetails in default JSON output", () => {
  const output = formatOutput(mockResult, "json");
  const parsed = JSON.parse(output);

  expect(parsed.reasonCodes).toEqual([
    "BLOCKED_DESTRUCTIVE_OPERATION",
    "BLOCKED_SCHEMA_RISK",
    "BLOCKED_HIGH_RISK_SCORE"
  ]);
  expect(parsed.reasonDetails).toBeUndefined();
});

it("includes structured reasonDetails in verbose JSON output", () => {
  const output = formatOutput(mockResult, "json", { verbose: true });
  const parsed = JSON.parse(output);

  expect(parsed.reasonDetails).toBeDefined();
  expect(Array.isArray(parsed.reasonDetails)).toBe(true);
  expect(parsed.reasonDetails).toHaveLength(3);

  expect(parsed.reasonDetails[0]).toEqual(
    expect.objectContaining({
      code: expect.any(String),
      label: expect.any(String),
      summary: expect.any(String),
      severity: expect.any(String),
      category: expect.any(String)
    })
  );
});

it("includes reason details in verbose text output", () => {
  const output = formatOutput(mockResult, "text", { verbose: true });

  expect(output).toContain("Reason Codes:");
  expect(output).toContain("Reason Details:");
  expect(output).toContain("code: BLOCKED_DESTRUCTIVE_OPERATION");
  expect(output).toContain("summary:");
});

it("does not include reason details in default text output", () => {
  const output = formatOutput(mockResult, "text");

  expect(output).toContain("Reason Codes:");
  expect(output).not.toContain("Reason Details:");
});
it("does not include auditSnapshot in default JSON output", () => {
  const output = formatOutput(mockResult, "json");
  const parsed = JSON.parse(output);

  expect(parsed.auditSnapshot).toBeUndefined();
});

it("includes auditSnapshot in verbose JSON output", () => {
  const output = formatOutput(mockResult, "json", { verbose: true });
  const parsed = JSON.parse(output);

  expect(parsed.auditSnapshot).toBeDefined();
  expect(parsed.auditSnapshot).toEqual(
    expect.objectContaining({
      mode: "blocked",
      confidenceScore: 25,
      riskScore: 75,
      confidenceFormula: "100 - 50 (destructive) - 25 (schema) = 25"
    })
  );

  expect(parsed.auditSnapshot.reasonCodes).toEqual([
    "BLOCKED_DESTRUCTIVE_OPERATION",
    "BLOCKED_SCHEMA_RISK",
    "BLOCKED_HIGH_RISK_SCORE"
  ]);

  expect(parsed.auditSnapshot.reasonDetails).toHaveLength(3);
  expect(parsed.auditSnapshot.triggeredBy).toEqual(["riskScore"]);
  expect(parsed.auditSnapshot.topRiskSummaries).toEqual([
    "[high] Potentially destructive change"
  ]);
});
it("includes audit summary in verbose text output", () => {
  const output = formatOutput(mockResult, "text", { verbose: true });

  expect(output).toContain("Audit Summary:");
  expect(output).toContain("triggered by: riskScore");
  expect(output).toContain(
    "confidence formula: 100 - 50 (destructive) - 25 (schema) = 25"
  );
});
it("keeps auditSnapshot reasonCodes order aligned with root reasonCodes", () => {
  const output = formatOutput(mockResult, "json", { verbose: true });
  const parsed = JSON.parse(output);

  expect(parsed.reasonCodes).toEqual(parsed.auditSnapshot.reasonCodes);
});
});