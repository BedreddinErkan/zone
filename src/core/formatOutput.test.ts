import { describe, it, expect } from "vitest";
import { formatOutput } from "./formatOutput.js";

// ---------------------------------------------------------------------------
// Shared fixture — mirrors RunAgentResult shape exactly
// ---------------------------------------------------------------------------

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
  ]
};

// ---------------------------------------------------------------------------
// text format — delegates to renderRunAgentResult
// ---------------------------------------------------------------------------

describe("formatOutput — text", () => {
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

// ---------------------------------------------------------------------------
// json format — JSON.stringify of result
// ---------------------------------------------------------------------------

describe("formatOutput — json", () => {
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
  });

  it("preserves confidence breakdown shape", () => {
    const parsed = JSON.parse(formatOutput(mockResult, "json"));

    expect(parsed.confidence.score).toBe(25);
    expect(parsed.confidence.breakdown.base).toBe(100);
    expect(parsed.confidence.breakdown.destructivePenalty).toBe(-50);
    expect(parsed.confidence.breakdown.schemaPenalty).toBe(-25);
  });

  it("preserves topRisks array with all fields", () => {
    const parsed = JSON.parse(formatOutput(mockResult, "json"));

    expect(parsed.topRisks).toHaveLength(1);
    expect(parsed.topRisks[0].title).toBe("Potentially destructive change");
    expect(parsed.topRisks[0].severity).toBe("high");
    expect(parsed.topRisks[0].reason).toContain("irreversible");
  });

  it("pretty-prints with 2-space indentation", () => {
    const output = formatOutput(mockResult, "json");
    expect(output).toContain("\n");
    expect(output).toContain("  ");
  });

  it("preserves multi-line explanation string inside JSON", () => {
    const parsed = JSON.parse(formatOutput(mockResult, "json"));
    expect(parsed.explanation).toContain("\n");
    expect(parsed.explanation).toContain("Primary cause:");
    expect(parsed.explanation).toContain("Confidence impact:");
  });

  it("empty topRisks array serializes correctly", () => {
    const result = { ...mockResult, topRisks: [] };
    const parsed = JSON.parse(formatOutput(result, "json"));
    expect(parsed.topRisks).toEqual([]);
  });
});
