import { describe, expect, it } from "vitest";
import { buildGeneratedPatchPlan } from "./buildGeneratedPatchPlan.js";

describe("buildGeneratedPatchPlan", () => {
  it("builds a structured generated patch plan", () => {
    const result = buildGeneratedPatchPlan({
      task: "replace foo with bar in src/a.ts",
      decision: {
        mode: "safe_to_apply",
        confidenceScore: 92
      },
      reasonCodes: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"]
    });

    expect(result.version).toBe(1);
    expect(typeof result.intent).toBe("string");
    expect(Array.isArray(result.operations)).toBe(true);
    expect(typeof result.summary).toBe("string");
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("adds a warning when decision mode is not safe_to_apply", () => {
    const result = buildGeneratedPatchPlan({
      task: "rename helper symbol",
      decision: {
        mode: "preview_only",
        confidenceScore: 61
      },
      reasonCodes: ["PREVIEW_LOW_CONFIDENCE"]
    });

    expect(result.warnings.some((item) => item.includes("preview_only"))).toBe(
      true
    );
  });
});