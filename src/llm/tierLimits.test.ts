import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { TIER_LIMITS, resolveTierLimits } from "./tierLimits.js";
import type { TaskClassification } from "./taskClassifier.js";
import { writeTierSettings, getTierSettingsPath } from "../visual/tierSettings.js";

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

  it("complex tier: Task tool allowed, 4 subagent calls, 800k tokens, 40 iter", () => {
    expect(TIER_LIMITS.complex.taskToolAllowed).toBe(true);
    expect(TIER_LIMITS.complex.maxSubagentCalls).toBe(4);
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

  it("per-request forceTierOverride beats ZONE_FORCE_TIER env", () => {
    process.env["ZONE_FORCE_TIER"] = "complex";
    const limits = resolveTierLimits(makeClassification("medium"), { forceTierOverride: "simple" });
    expect(limits).toBe(TIER_LIMITS.simple);
  });

  it("ZONE_FORCE_TIER env is used when no per-request forceTierOverride is set", () => {
    process.env["ZONE_FORCE_TIER"] = "complex";
    const limits = resolveTierLimits(makeClassification("medium"));
    expect(limits).toBe(TIER_LIMITS.complex);
  });

  it("ignores an invalid forceTierOverride and falls through to env/classification", () => {
    process.env["ZONE_FORCE_TIER"] = "simple";
    const limits = resolveTierLimits(makeClassification("medium"), {
      forceTierOverride: "bogus" as "simple",
    });
    expect(limits).toBe(TIER_LIMITS.simple); // env takes over
  });
});

describe("L.3: resolveTierLimits with user overrides", () => {
  const SETTINGS_PATH = getTierSettingsPath();
  let backup: string | null = null;

  beforeEach(() => {
    delete process.env["ZONE_FORCE_TIER"];
    backup = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, "utf8") : null;
    if (fs.existsSync(SETTINGS_PATH)) fs.unlinkSync(SETTINGS_PATH);
  });

  afterEach(() => {
    delete process.env["ZONE_FORCE_TIER"];
    if (backup !== null) {
      fs.writeFileSync(SETTINGS_PATH, backup, "utf8");
    } else if (fs.existsSync(SETTINGS_PATH)) {
      fs.unlinkSync(SETTINGS_PATH);
    }
  });

  it("applies user tokenBudgetCap override for simple tier", () => {
    writeTierSettings({ simple: { tokenBudgetCap: 100_000 } });
    const limits = resolveTierLimits(makeClassification("simple"));
    expect(limits.tokenBudgetCap).toBe(100_000);
  });

  it("preserves taskToolAllowed=false for simple tier regardless of overrides", () => {
    writeTierSettings({ simple: { tokenBudgetCap: 100_000, iterCap: 8 } });
    const limits = resolveTierLimits(makeClassification("simple"));
    expect(limits.taskToolAllowed).toBe(false);
  });

  it("applies user iterCap override for medium tier", () => {
    writeTierSettings({ medium: { iterCap: 18 } });
    const limits = resolveTierLimits(makeClassification("medium"));
    expect(limits.iterCap).toBe(18);
    expect(limits.taskToolAllowed).toBe(true);
  });

  it("applies user maxSubagentCalls override for complex tier", () => {
    writeTierSettings({ complex: { maxSubagentCalls: 1 } });
    const limits = resolveTierLimits(makeClassification("complex"));
    expect(limits.maxSubagentCalls).toBe(1);
  });

  it("falls back to TIER_LIMITS defaults when no user settings file exists", () => {
    const limits = resolveTierLimits(makeClassification("medium"));
    expect(limits).toEqual(TIER_LIMITS.medium);
  });

  it("ZONE_FORCE_TIER skips user overrides entirely", () => {
    writeTierSettings({ simple: { tokenBudgetCap: 100_000, iterCap: 5 } });
    process.env["ZONE_FORCE_TIER"] = "simple";
    const limits = resolveTierLimits(makeClassification("complex"));
    // Returns raw TIER_LIMITS.simple — not the user override.
    expect(limits).toBe(TIER_LIMITS.simple);
    expect(limits.tokenBudgetCap).toBe(400_000);
  });

  it("partial override: only specified fields are overridden", () => {
    writeTierSettings({ medium: { iterCap: 30 } });
    const limits = resolveTierLimits(makeClassification("medium"));
    expect(limits.iterCap).toBe(30);
    expect(limits.tokenBudgetCap).toBe(TIER_LIMITS.medium.tokenBudgetCap);
    expect(limits.maxSubagentCalls).toBe(TIER_LIMITS.medium.maxSubagentCalls);
  });
});
