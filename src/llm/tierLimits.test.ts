import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TIER_LIMITS, resolveTierLimits } from "./tierLimits.js";
import type { TaskClassification } from "./taskClassifier.js";

function makeClassification(tier: "simple" | "medium" | "complex"): TaskClassification {
  return {
    tier,
    estimatedFiles: 1,
    estimatedIterations: 5,
    needsSubagent: tier !== "simple",
    confidence: 0.9,
    classifierCostUsd: 0.001,
    classifierLatencyMs: 50,
    classifierModel: "gpt-5.4-mini",
  };
}

describe("TIER_LIMITS", () => {
  it("simple tier: Task tool disallowed, 0 subagent calls, 400k tokens, 15 iter", () => {
    expect(TIER_LIMITS.simple.taskToolAllowed).toBe(false);
    expect(TIER_LIMITS.simple.maxSubagentCalls).toBe(0);
    expect(TIER_LIMITS.simple.tokenBudgetCap).toBe(400_000);
    expect(TIER_LIMITS.simple.iterCap).toBe(15);
  });

  it("medium tier: Task tool allowed, 1 subagent call, 600k tokens, 25 iter", () => {
    expect(TIER_LIMITS.medium.taskToolAllowed).toBe(true);
    expect(TIER_LIMITS.medium.maxSubagentCalls).toBe(1);
    expect(TIER_LIMITS.medium.tokenBudgetCap).toBe(600_000);
    expect(TIER_LIMITS.medium.iterCap).toBe(25);
  });

  it("complex tier: Task tool allowed, 2 subagent calls, 800k tokens, 40 iter", () => {
    expect(TIER_LIMITS.complex.taskToolAllowed).toBe(true);
    expect(TIER_LIMITS.complex.maxSubagentCalls).toBe(2);
    expect(TIER_LIMITS.complex.tokenBudgetCap).toBe(800_000);
    expect(TIER_LIMITS.complex.iterCap).toBe(40);
  });
});

describe("resolveTierLimits", () => {
  beforeEach(() => {
    delete process.env["ZONE_FORCE_TIER"];
  });

  afterEach(() => {
    delete process.env["ZONE_FORCE_TIER"];
  });

  it("returns simple limits for a simple classification", () => {
    const limits = resolveTierLimits(makeClassification("simple"));
    expect(limits).toBe(TIER_LIMITS.simple);
  });

  it("returns medium limits for a medium classification", () => {
    const limits = resolveTierLimits(makeClassification("medium"));
    expect(limits).toBe(TIER_LIMITS.medium);
  });

  it("returns complex limits for a complex classification", () => {
    const limits = resolveTierLimits(makeClassification("complex"));
    expect(limits).toBe(TIER_LIMITS.complex);
  });

  it("falls back to medium when classification is null", () => {
    expect(resolveTierLimits(null)).toBe(TIER_LIMITS.medium);
  });

  it("falls back to medium when classification is undefined", () => {
    expect(resolveTierLimits(undefined)).toBe(TIER_LIMITS.medium);
  });

  it("falls back to medium when called with no arguments", () => {
    expect(resolveTierLimits()).toBe(TIER_LIMITS.medium);
  });

  it("ZONE_FORCE_TIER=simple overrides a complex classification", () => {
    process.env["ZONE_FORCE_TIER"] = "simple";
    const limits = resolveTierLimits(makeClassification("complex"));
    expect(limits).toBe(TIER_LIMITS.simple);
  });

  it("ZONE_FORCE_TIER=complex overrides a simple classification", () => {
    process.env["ZONE_FORCE_TIER"] = "complex";
    const limits = resolveTierLimits(makeClassification("simple"));
    expect(limits).toBe(TIER_LIMITS.complex);
  });

  it("ZONE_FORCE_TIER=medium overrides a complex classification", () => {
    process.env["ZONE_FORCE_TIER"] = "medium";
    const limits = resolveTierLimits(makeClassification("complex"));
    expect(limits).toBe(TIER_LIMITS.medium);
  });

  it("ignores an invalid ZONE_FORCE_TIER and uses classification", () => {
    process.env["ZONE_FORCE_TIER"] = "bogus";
    const limits = resolveTierLimits(makeClassification("simple"));
    expect(limits).toBe(TIER_LIMITS.simple);
  });

  it("ignores an invalid ZONE_FORCE_TIER and falls back to medium when no classification", () => {
    process.env["ZONE_FORCE_TIER"] = "bogus";
    expect(resolveTierLimits(null)).toBe(TIER_LIMITS.medium);
  });
});
