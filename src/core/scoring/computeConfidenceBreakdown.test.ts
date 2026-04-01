import { describe, expect, it } from "vitest";
import { computeConfidenceBreakdown } from "./computeConfidenceBreakdown.js";

describe("computeConfidenceBreakdown", () => {
  it("returns full score when all signals are healthy", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: 92,
      storageConfidence: 88,
      architectureWarnings: [],
      patchRiskWarnings: [],
      validationErrors: [],
      hasValidatedFiles: true,
    });

    expect(result.baseScore).toBe(100);
    expect(result.finalScore).toBe(100);
    expect(result.factors).toHaveLength(0);
    expect(result.summary.totalPenalty).toBe(0);
    expect(result.summary.hasCriticalRisk).toBe(false);
  });

  it("applies schema confidence penalty for very low schema confidence", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: 35,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      validationErrors: [],
      hasValidatedFiles: true,
    });

    expect(result.finalScore).toBe(70);
    expect(result.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "schema_confidence",
          impact: -30,
          severity: "critical",
        }),
      ])
    );
    expect(result.summary.hasCriticalRisk).toBe(true);
  });

  it("applies storage confidence penalty for low storage confidence", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: 90,
      storageConfidence: 50,
      architectureWarnings: [],
      patchRiskWarnings: [],
      validationErrors: [],
      hasValidatedFiles: true,
    });

    expect(result.finalScore).toBe(85);
    expect(result.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "storage_confidence",
          impact: -15,
          severity: "warning",
        }),
      ])
    );
  });

  it("applies penalty when validated files are missing", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      validationErrors: [],
      hasValidatedFiles: false,
    });

    expect(result.finalScore).toBe(80);
    expect(result.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "missing_validated_files",
          impact: -20,
        }),
      ])
    );
  });

  it("caps architecture warning penalty", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [
        "warning-1",
        "warning-2",
        "warning-3",
        "warning-4",
        "warning-5",
      ],
      patchRiskWarnings: [],
      validationErrors: [],
      hasValidatedFiles: true,
    });

    expect(result.finalScore).toBe(82);
    expect(result.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "architecture_warnings",
          impact: -18,
        }),
      ])
    );
  });

  it("caps patch risk warning penalty", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [
        "risk-1",
        "risk-2",
        "risk-3",
        "risk-4",
        "risk-5",
      ],
      validationErrors: [],
      hasValidatedFiles: true,
    });

    expect(result.finalScore).toBe(76);
    expect(result.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "patch_risk_warnings",
          impact: -24,
        }),
      ])
    );
  });

  it("marks validation errors as critical and applies capped penalty", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      validationErrors: ["schema mismatch", "unsafe write", "bad target"],
      hasValidatedFiles: true,
    });

    expect(result.finalScore).toBe(20);
    expect(result.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "validation_errors",
          impact: -80,
          severity: "critical",
        }),
      ])
    );
    expect(result.summary.hasCriticalRisk).toBe(true);
  });

  it("combines multiple penalties deterministically", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: 58,
      storageConfidence: 61,
      architectureWarnings: ["route mismatch", "service mismatch"],
      patchRiskWarnings: ["wide replacement"],
      validationErrors: [],
      hasValidatedFiles: false,
    });

expect(result.finalScore).toBe(34);
expect(result.summary.totalPenalty).toBe(66);
expect(result.summary.totalBonus).toBe(0);
  });

  it("clamps invalid confidence inputs into safe range", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: Number.NaN,
      storageConfidence: -10,
      architectureWarnings: [],
      patchRiskWarnings: [],
      validationErrors: [],
      hasValidatedFiles: true,
    });

    expect(result.finalScore).toBe(45);
    expect(result.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "schema_confidence",
          impact: -30,
        }),
        expect.objectContaining({
          key: "storage_confidence",
          impact: -25,
        }),
      ])
    );
  });

  it("never returns a score below zero", () => {
    const result = computeConfidenceBreakdown({
      schemaConfidence: 0,
      storageConfidence: 0,
      architectureWarnings: ["a", "b", "c", "d", "e"],
      patchRiskWarnings: ["x", "y", "z", "w"],
      validationErrors: ["err-1", "err-2", "err-3"],
      hasValidatedFiles: false,
    });

    expect(result.finalScore).toBe(0);
  });

  it("returns identical output for identical input", () => {
    const input = {
      schemaConfidence: 58,
      storageConfidence: 61,
      architectureWarnings: ["route mismatch", "service mismatch"],
      patchRiskWarnings: ["wide replacement"],
      validationErrors: [],
      hasValidatedFiles: false,
    };

    const result1 = computeConfidenceBreakdown(input);
    const result2 = computeConfidenceBreakdown(input);

    expect(result1).toEqual(result2);
  });
});