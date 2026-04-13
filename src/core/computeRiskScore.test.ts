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

  it("returns weighted score for destructive database work", () => {
    const result = computeRiskScore("delete user table from database");

    expect(result.score).toBe(50);
    expect(result.signals).toContain("destructive");
    expect(result.signals).toContain("schema");
  });

  it("returns mass_scope signal for 'delete all users'", () => {
    const result = computeRiskScore("delete all users");

    expect(result.signals).toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(40);
  });

  it("does NOT return mass_scope signal for 'truncate sessions' without a scope word", () => {
    const result = computeRiskScore("truncate sessions");

    expect(result.signals).not.toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(0);
  });

  it("does NOT return mass_scope signal for singular 'delete user'", () => {
    const result = computeRiskScore("delete user");

    expect(result.signals).not.toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(0);
  });

  it("returns mass_scope signal for 'wipe all data'", () => {
    const result = computeRiskScore("wipe all data");

    expect(result.signals).toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(40);
  });

  it("returns mass_scope signal for 'purge all cache'", () => {
    const result = computeRiskScore("purge all cache");

    expect(result.signals).toContain("mass_scope");
    expect(result.breakdown.massScope).toBe(40);
  });

  it("does not treat UI cleanup wording as destructive or mass_scope", () => {
    const result = computeRiskScore(
      "clean up every card by adding a tiny new badge to the header"
    );

    expect(result.signals).not.toContain("destructive");
    expect(result.signals).not.toContain("mass_scope");
    expect(result.breakdown.destructive).toBe(0);
    expect(result.breakdown.massScope).toBe(0);
  });

  it("stacks destructive + mass_scope for 'delete all user sessions' with compound penalty", () => {
    const result = computeRiskScore("delete all user sessions");

    expect(result.signals).toContain("destructive");
    expect(result.signals).toContain("mass_scope");
    expect(result.breakdown.destructive).toBe(50);
    expect(result.breakdown.massScope).toBe(40);
    expect(result.score).toBe(100);
  });

  it("does not treat model test tasks as schema risk", () => {
    const result = computeRiskScore("add a model test for payment validation");

    expect(result.signals).not.toContain("schema");
    expect(result.breakdown.schema).toBe(0);
  });

  it("adds destructive + critical compound penalty", () => {
    const result = computeRiskScore("delete auth tokens in production");

    expect(result.signals).toContain("destructive");
    expect(result.signals).toContain("critical_domain");
    expect(result.score).toBe(85);
  });

  it("clamps score to 100", () => {
    const result = computeRiskScore(
      "delete remove drop reset overwrite database schema migration payment auth production password token"
    );

    expect(result.score).toBeLessThanOrEqual(100);
  });
});
