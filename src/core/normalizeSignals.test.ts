import { describe, expect, it } from "vitest";
import { normalizeSignals } from "./normalizeSignals.js";

describe("normalizeSignals", () => {
  it("normalizes destructive signal", () => {
    const result = normalizeSignals(["destructive"]);

    expect(result[0]).toMatchObject({
      type: "destructive",
      severity: "high",
      confidenceImpact: -50
    });
  });

  it("normalizes multiple signals", () => {
    const result = normalizeSignals(["schema", "mass_scope"]);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.type)).toEqual(["schema", "mass_scope"]);
  });

  it("returns empty for no signals", () => {
    const result = normalizeSignals([]);
    expect(result).toHaveLength(0);
  });
});