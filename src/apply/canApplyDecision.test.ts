import { describe, expect, it } from "vitest";
import { canApplyDecision } from "./canApplyDecision.js";
import type { RunAgentResult, RunAgentMode } from "../core/runAgent.js";

function buildRunAgentResult(mode: RunAgentMode): RunAgentResult {
  return {
    task: "rename helper function",
    decision: {
      mode,
      confidenceScore: 82
    },
    risk: {
      score: 18,
      breakdown: {
        destructive: 0,
        schema: 0,
        critical: 0,
        lowRisk: 10,
        massScope: 0
      }
    },
    confidence: {
      score: 82,
      breakdown: {
        base: 100,
        destructivePenalty: 0,
        schemaPenalty: 0,
        criticalPenalty: 0,
        massScopePenalty: 0,
        lowRiskBonus: 0
      }
    },
    explanation: "SAFE TO APPLY",
    recommendation: "Safe",
    topRisks: [],
    trace: {} as any, // ✅ FIX
    reasonCodes: []
  };
}
describe("canApplyDecision", () => {
  it("returns blocked eligibility for blocked mode", () => {
    const result = buildRunAgentResult("blocked");

    const eligibility = canApplyDecision(result);

    expect(eligibility).toEqual({
      allowed: false,
      reason: "blocked_mode",
      message: "Blocked decisions cannot be applied."
    });
  });

  // Phase J.1: legacy preview_only inputs (e.g. older serialized runs) still
  // allow apply. The message is unified — no more preview_only-specific copy.
  it("returns confirmed apply eligibility for legacy preview_only mode (Phase J.1)", () => {
    const result = buildRunAgentResult("preview_only");

    const eligibility = canApplyDecision(result);

    expect(eligibility).toEqual({
      allowed: true,
      strategy: "confirmed_apply",
      message: "Decisions may be applied with explicit confirmation."
    });
  });

  it("returns confirmed apply eligibility for safe_to_apply mode", () => {
    const result = buildRunAgentResult("safe_to_apply");

    const eligibility = canApplyDecision(result);

    expect(eligibility).toEqual({
      allowed: true,
      strategy: "confirmed_apply",
      message: "Decisions may be applied with explicit confirmation."
    });
  });
});