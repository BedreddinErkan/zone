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

  // -----------------------------------------------------------------------
  // mass_scope signal
  // -----------------------------------------------------------------------

  it("returns mass_scope signal for 'delete all users'", () => {
    const result = computeRiskScore("delete all users");

    expect(result.signals).toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(25);
  });

  it("returns mass_scope signal for 'truncate sessions'", () => {
    const result = computeRiskScore("truncate sessions");

    expect(result.signals).toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(25);
  });

  it("does NOT return mass_scope signal for singular 'delete user'", () => {
    const result = computeRiskScore("delete user");

    expect(result.signals).not.toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(0);
  });

  it("returns mass_scope signal for 'wipe all data'", () => {
    const result = computeRiskScore("wipe all data");

    expect(result.signals).toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(25);
  });

  it("returns mass_scope signal for 'purge all cache'", () => {
    const result = computeRiskScore("purge all cache");

    expect(result.signals).toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(25);
  });

  it("stacks destructive + mass_scope for 'delete all user sessions' → score 75", () => {
    const result = computeRiskScore("delete all user sessions");

    expect(result.signals).toContain("destructive");
    expect(result.signals).toContain("mass_scope");
    expect(result.breakdown.destructive).toBe(50);
    expect(result.breakdown.massScope).toBe(25);
    expect(result.score).toBe(75);
  });

  it("clamps score to 100", () => {
    const result = computeRiskScore(
      "delete remove drop reset overwrite database schema migration payment auth production password token"
    );

    expect(result.score).toBeLessThanOrEqual(100);
  });
});