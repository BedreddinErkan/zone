import { describe, expect, it } from "vitest";
import { computeConfidenceScore } from "./computeConfidenceScore.js";

describe("computeConfidenceScore", () => {
  it("returns full confidence for zero-risk input", () => {
    const result = computeConfidenceScore({
      breakdown: {
        destructive: 0,
        schema: 0,
        critical: 0,
        massScope: 0,
        lowRisk: 0
      }
    });

    expect(result.score).toBe(100);
    expect(result.breakdown).toEqual({
      base: 100,
      destructivePenalty: 0,
      schemaPenalty: 0,
      criticalPenalty: 0,
      massScopePenalty: 0,
      lowRiskBonus: 0
    });
  });

  it("applies destructive penalty", () => {
    const result = computeConfidenceScore({
      breakdown: {
        destructive: 50,
        schema: 0,
        critical: 0,
        massScope: 0,
        lowRisk: 0
      }
    });

    expect(result.score).toBe(50);
    expect(result.breakdown.destructivePenalty).toBe(-50);
  });

  it("applies schema and critical penalties together", () => {
    const result = computeConfidenceScore({
      breakdown: {
        destructive: 0,
        schema: 25,
        critical: 20,
        massScope: 0,
        lowRisk: 0
      }
    });

    expect(result.score).toBe(55);
    expect(result.breakdown.schemaPenalty).toBe(-25);
    expect(result.breakdown.criticalPenalty).toBe(-20);
  });

  it("applies mass_scope penalty", () => {
    const result = computeConfidenceScore({
      breakdown: {
        destructive: 0,
        schema: 0,
        critical: 0,
        massScope: 30,
        lowRisk: 0
      }
    });

    expect(result.score).toBe(85);
    expect(result.breakdown.massScopePenalty).toBe(-30);
  });

  it("applies mass_scope together with other penalties", () => {
    const result = computeConfidenceScore({
      breakdown: {
        destructive: 50,
        schema: 0,
        critical: 0,
        massScope: 30,
        lowRisk: 0
      }
    });

    expect(result.score).toBe(20);
    expect(result.breakdown.destructivePenalty).toBe(-50);
    expect(result.breakdown.massScopePenalty).toBe(-30);
  });
});