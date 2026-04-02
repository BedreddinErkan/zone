import { describe, expect, it } from "vitest";
import { renderGeneratedPlanConversionFailure } from "./renderGeneratedPlanConversionFailure.js";

describe("renderGeneratedPlanConversionFailure", () => {
  it("renders deterministic failure output", () => {
    const output = renderGeneratedPlanConversionFailure({
      canConvert: false,
      code: "EMPTY_OPERATIONS",
      reason: "Generated plan must contain exactly one operation."
    });

    expect(output).toBe(
      [
        "=== GENERATED PATCH PLAN CONVERSION ===",
        "Status: failed",
        "Reason code: EMPTY_OPERATIONS",
        "Summary: Generated plan contains no operations.",
        "Details: Generated plan must contain exactly one operation.",
        "Apply status: blocked",
        "No changes were applied."
      ].join("\n")
    );
  });

  it("falls back when meta is missing", () => {
    const output = renderGeneratedPlanConversionFailure({
      canConvert: false,
      code: "UNKNOWN_CODE" as any,
      reason: "something"
    });

    expect(output).toContain("Generated plan conversion failed.");
  });
});