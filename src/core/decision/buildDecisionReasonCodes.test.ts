import { describe, expect, it } from "vitest";
import { buildDecisionReasonCodes } from "./buildDecisionReasonCodes.js";

describe("buildDecisionReasonCodes", () => {
  it("returns blocked destructive and high risk codes", () => {
    const result = buildDecisionReasonCodes({
      mode: "blocked",
      riskScore: 80,
      confidenceScore: 25,
      normalizedSignals: [{ type: "destructive" }]
    });

    expect(result).toContain("BLOCKED_DESTRUCTIVE_OPERATION");
    expect(result).toContain("BLOCKED_HIGH_RISK_SCORE");
  });

  it("returns blocked schema risk code", () => {
    const result = buildDecisionReasonCodes({
      mode: "blocked",
      riskScore: 72,
      confidenceScore: 40,
      normalizedSignals: [{ type: "schema" }]
    });

    expect(result).toContain("BLOCKED_SCHEMA_RISK");
  });

  it("returns preview mass scope and low confidence codes", () => {
    const result = buildDecisionReasonCodes({
      mode: "preview_only",
      riskScore: 45,
      confidenceScore: 55,
      normalizedSignals: [{ type: "massScope" }]
    });

    expect(result).toContain("PREVIEW_MASS_SCOPE_CHANGE");
    expect(result).toContain("PREVIEW_LOW_CONFIDENCE");
  });

  it("returns preview schema uncertainty code", () => {
    const result = buildDecisionReasonCodes({
      mode: "preview_only",
      riskScore: 30,
      confidenceScore: 60,
      normalizedSignals: [{ type: "schema" }]
    });

    expect(result).toContain("PREVIEW_SCHEMA_UNCERTAINTY");
  });

  it("returns safe low risk and high confidence codes", () => {
    const result = buildDecisionReasonCodes({
      mode: "safe_to_apply",
      riskScore: 5,
      confidenceScore: 92,
      normalizedSignals: [{ type: "lowRisk" }]
    });

    expect(result).toContain("SAFE_LOW_RISK_LOCALIZED");
    expect(result).toContain("SAFE_HIGH_CONFIDENCE");
  });

  it("does not return duplicate codes", () => {
    const result = buildDecisionReasonCodes({
      mode: "blocked",
      riskScore: 85,
      confidenceScore: 20,
      normalizedSignals: [
        { type: "destructive" },
        { type: "destructive" }
      ]
    });

    const destructiveCodes = result.filter(
      (code) => code === "BLOCKED_DESTRUCTIVE_OPERATION"
    );

    expect(destructiveCodes).toHaveLength(1);
  });

  it("returns an empty array when no rule matches", () => {
    const result = buildDecisionReasonCodes({
      mode: "safe_to_apply",
      riskScore: 20,
      confidenceScore: 60,
      normalizedSignals: []
    });

    expect(result).toEqual([]);
  });
});