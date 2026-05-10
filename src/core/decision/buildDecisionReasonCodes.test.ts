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

  // Phase J.4: PREVIEW_* codes are no longer emitted — RunAgentMode dropped
  // the "preview_only" variant after Phase J.1 collapsed soft signals into
  // safe_to_apply. The codes still exist in REASON_CODE_PRIORITY for legacy
  // fixture compatibility, but the generator only emits the BLOCKED_* and
  // SAFE_* families. The two assertions below now check that "preview_only"
  // mode (passed defensively) yields an empty code set, not the removed
  // PREVIEW_* names.
  it("emits no PREVIEW_* codes for the (legacy) preview_only mode", () => {
    const result = buildDecisionReasonCodes({
      // @ts-expect-error legacy mode no longer in RunAgentMode union
      mode: "preview_only",
      riskScore: 45,
      confidenceScore: 55,
      normalizedSignals: [{ type: "massScope" }]
    });

    expect(result).not.toContain("PREVIEW_MASS_SCOPE_CHANGE");
    expect(result).not.toContain("PREVIEW_LOW_CONFIDENCE");
    expect(result).toEqual([]);
  });

  it("emits no PREVIEW_* code for legacy preview_only with schema signal", () => {
    const result = buildDecisionReasonCodes({
      // @ts-expect-error legacy mode no longer in RunAgentMode union
      mode: "preview_only",
      riskScore: 30,
      confidenceScore: 60,
      normalizedSignals: [{ type: "schema" }]
    });

    expect(result).not.toContain("PREVIEW_SCHEMA_UNCERTAINTY");
    expect(result).toEqual([]);
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