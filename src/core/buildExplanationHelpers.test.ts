import { describe, it, expect } from "vitest";
import {
  buildPrimaryCause,
  buildConfidenceImpactLine,
} from "./runAgent.js";

// ---------------------------------------------------------------------------
// buildPrimaryCause
// ---------------------------------------------------------------------------

describe("buildPrimaryCause", () => {
  it("returns 'destructive operation' for destructive signal", () => {
    expect(buildPrimaryCause(["destructive"])).toBe("destructive operation");
  });

  it("returns 'schema-sensitive change' for schema signal", () => {
    expect(buildPrimaryCause(["schema"])).toBe("schema-sensitive change");
  });

  it("returns 'critical domain access' for critical_domain signal", () => {
    expect(buildPrimaryCause(["critical_domain"])).toBe("critical domain access");
  });

  it("prefers destructive over schema when both are present (priority order)", () => {
    expect(buildPrimaryCause(["destructive", "schema"])).toBe("destructive operation");
  });

  it("prefers schema over critical_domain when both are present", () => {
    expect(buildPrimaryCause(["schema", "critical_domain"])).toBe("schema-sensitive change");
  });

  it("returns 'general task' for low_risk-only signal", () => {
    expect(buildPrimaryCause(["low_risk"])).toBe("general task");
  });

  it("returns 'general task' for empty signals", () => {
    expect(buildPrimaryCause([])).toBe("general task");
  });
});

// ---------------------------------------------------------------------------
// buildConfidenceImpactLine
// ---------------------------------------------------------------------------

describe("buildConfidenceImpactLine", () => {
  it("returns schema penalty line for schema-only penalty", () => {
    const breakdown = {
      base: 100,
      destructivePenalty: 0,
      schemaPenalty: -25,
      criticalPenalty: 0,
      lowRiskBonus: 0,
    };
    expect(buildConfidenceImpactLine(breakdown)).toBe("schema penalty: -25");
  });

  it("returns combined line for destructive + schema penalties", () => {
    const breakdown = {
      base: 100,
      destructivePenalty: -50,
      schemaPenalty: -25,
      criticalPenalty: 0,
      lowRiskBonus: 0,
    };
    expect(buildConfidenceImpactLine(breakdown)).toBe(
      "destructive penalty: -50, schema penalty: -25"
    );
  });

  it("returns critical penalty line", () => {
    const breakdown = {
      base: 100,
      destructivePenalty: 0,
      schemaPenalty: 0,
      criticalPenalty: -15,
      lowRiskBonus: 0,
    };
    expect(buildConfidenceImpactLine(breakdown)).toBe("critical penalty: -15");
  });

  it("returns low-risk bonus line with explicit + prefix", () => {
    const breakdown = {
      base: 100,
      destructivePenalty: 0,
      schemaPenalty: 0,
      criticalPenalty: 0,
      lowRiskBonus: 10,
    };
    expect(buildConfidenceImpactLine(breakdown)).toBe("low-risk bonus: +10");
  });

  it("returns null when all adjustments are zero", () => {
    const breakdown = {
      base: 100,
      destructivePenalty: 0,
      schemaPenalty: 0,
      criticalPenalty: 0,
      lowRiskBonus: 0,
    };
    expect(buildConfidenceImpactLine(breakdown)).toBeNull();
  });

  it("includes all non-zero adjustments in correct order", () => {
    const breakdown = {
      base: 100,
      destructivePenalty: -50,
      schemaPenalty: -25,
      criticalPenalty: -15,
      lowRiskBonus: 5,
    };
    expect(buildConfidenceImpactLine(breakdown)).toBe(
      "destructive penalty: -50, schema penalty: -25, critical penalty: -15, low-risk bonus: +5"
    );
  });
});
