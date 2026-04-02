import { describe, expect, it } from "vitest";
import { buildConfidenceBreakdownFromSignals } from "./buildConfidenceBreakdownFromSignals.js";

describe("buildConfidenceBreakdownFromSignals", () => {
  it("returns zeroed breakdown for empty signals", () => {
    const result = buildConfidenceBreakdownFromSignals([]);

    expect(result).toEqual({
      destructive: 0,
      schema: 0,
      critical: 0,
      massScope: 0,
      lowRisk: 0
    });
  });

  it("maps destructive signal to destructive penalty input", () => {
    const result = buildConfidenceBreakdownFromSignals(["destructive"]);

    expect(result).toEqual({
      destructive: 50,
      schema: 0,
      critical: 0,
      massScope: 0,
      lowRisk: 0
    });
  });

  it("maps schema, critical_domain, and mass_scope correctly", () => {
    const result = buildConfidenceBreakdownFromSignals([
      "schema",
      "critical_domain",
      "mass_scope"
    ]);

    expect(result).toEqual({
      destructive: 0,
      schema: 25,
      critical: 20,
      massScope: 25,
      lowRisk: 0
    });
  });

  it("maps low_risk to bonus-compatible negative value", () => {
    const result = buildConfidenceBreakdownFromSignals(["low_risk"]);

    expect(result).toEqual({
      destructive: 0,
      schema: 0,
      critical: 0,
      massScope: 0,
      lowRisk: -20
    });
  });

  it("combines multiple signals deterministically", () => {
    const result = buildConfidenceBreakdownFromSignals([
      "destructive",
      "schema",
      "mass_scope",
      "low_risk"
    ]);

    expect(result).toEqual({
      destructive: 50,
      schema: 25,
      critical: 0,
      massScope: 25,
      lowRisk: -20
    });
  });
});