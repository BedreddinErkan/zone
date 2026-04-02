import { describe, expect, it } from "vitest";
import { computeRiskScore } from "./computeRiskScore.js";

describe("computeRiskScore", () => {
  it("returns low score for low-risk rename work", () => {
    const result = computeRiskScore("rename helper function");

    expect(result.score).toBe(0);
    expect(result.signals).toContain("low_risk");
  });

  it("returns medium score for schema work", () => {
    const result = computeRiskScore("add schema migration for treatment timeline");

    expect(result.score).toBe(25);
    expect(result.signals).toContain("schema");
  });

  it("returns medium score for critical domain work", () => {
    const result = computeRiskScore("update payment service logic");

    expect(result.score).toBe(20);
    expect(result.signals).toContain("critical_domain");
  });

  it("returns high score for destructive database work", () => {
    const result = computeRiskScore("delete user table from database");

    expect(result.score).toBe(75);
    expect(result.signals).toContain("destructive");
    expect(result.signals).toContain("schema");
  });

  it("clamps score to 100", () => {
    const result = computeRiskScore(
      "delete remove drop reset overwrite database schema migration payment auth production password token"
    );

    expect(result.score).toBeLessThanOrEqual(100);
  });
});