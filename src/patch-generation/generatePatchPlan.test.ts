import { describe, expect, it } from "vitest";
import { generatePatchPlan } from "./generatePatchPlan.js";

describe("generatePatchPlan", () => {
  it("returns blocked result when decision mode is blocked", () => {
    const result = generatePatchPlan({
      task: "rename helper function",
      decision: {
        mode: "blocked",
        confidenceScore: 22
      },
      reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"]
    });

    expect(result).toEqual({
      allowed: false,
      strategy: "blocked",
      intent: "rename_symbol",
      operations: [],
      metadata: {
        reason: "Patch generation blocked by decision mode.",
        derivedFrom: ["BLOCKED_HIGH_RISK_SCORE"],
        confidenceScore: 22
      }
    });
  });

  it("returns blocked result when task intent is unknown", () => {
    const result = generatePatchPlan({
      task: "rewrite authentication flow",
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 88
      },
      reasonCodes: ["SAFE_LOW_RISK"]
    });

    expect(result).toEqual({
      allowed: false,
      strategy: "safe",
      intent: "unknown",
      operations: [],
      metadata: {
        reason: "Patch generation blocked because task intent is unknown.",
        derivedFrom: ["SAFE_LOW_RISK"],
        confidenceScore: 88
      }
    });
  });

  it("returns blocked result when intent is not allowed for restricted strategy", () => {
    const result = generatePatchPlan({
      task: "update import path in api client",
      decision: {
        mode: "preview_only",
        confidenceScore: 61
      },
      reasonCodes: ["PREVIEW_REQUIRED"]
    });

    expect(result).toEqual({
      allowed: false,
      strategy: "restricted",
      intent: "update_import",
      operations: [],
      metadata: {
        reason: "Patch intent is not allowed for strategy: restricted.",
        derivedFrom: ["PREVIEW_REQUIRED"],
        confidenceScore: 61
      }
    });
  });

  it("generates a patch plan for allowed restricted intent", () => {
    const result = generatePatchPlan({
      task: "rename helper function",
      decision: {
        mode: "preview_only",
        confidenceScore: 73
      },
      reasonCodes: ["PREVIEW_MASS_SCOPE"]
    });

    expect(result).toEqual({
      allowed: true,
      strategy: "restricted",
      intent: "rename_symbol",
      operations: [
        {
          type: "rename",
          scope: "single_file"
        }
      ],
      metadata: {
        reason: "Patch plan generated successfully from deterministic intent classification.",
        derivedFrom: ["PREVIEW_MASS_SCOPE"],
        confidenceScore: 73
      }
    });
  });

  it("generates a patch plan for safe strategy", () => {
    const result = generatePatchPlan({
      task: "update import path in api client",
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 91
      },
      reasonCodes: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"]
    });

    expect(result).toEqual({
      allowed: true,
      strategy: "safe",
      intent: "update_import",
      operations: [
        {
          type: "update_import",
          scope: "single_file"
        }
      ],
      metadata: {
        reason: "Patch plan generated successfully from deterministic intent classification.",
        derivedFrom: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"],
        confidenceScore: 91
      }
    });
  });

  it("defaults reasonCodes to an empty array", () => {
    const result = generatePatchPlan({
      task: "add comment above helper",
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 85
      }
    });

    expect(result.metadata.derivedFrom).toEqual([]);
  });

  it("is deterministic for repeated calls", () => {
    const input = {
      task: "replace exact text in config",
      decision: {
        mode: "safe_to_apply" as const,
        confidenceScore: 84
      },
      reasonCodes: ["SAFE_LOW_RISK"]
    };

    const first = generatePatchPlan(input);
    const second = generatePatchPlan(input);

    expect(first).toEqual(second);
  });
});