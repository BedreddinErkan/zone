import { describe, expect, it } from "vitest";
import { convertGeneratedPlanToPatchPlan } from "./convertGeneratedPlanToPatchPlan.js";
import type { GeneratedPatchPlan } from "./generatedPlanConversionTypes.js";

function buildPlan(
  overrides: Partial<GeneratedPatchPlan>
): GeneratedPatchPlan {
  return {
    version: 1,
    summary: "generated plan",
    warnings: [],
    intent: "safe_replace",
    operations: [],
    ...overrides,
  };
}

describe("convertGeneratedPlanToPatchPlan", () => {
  it("throws when generated plan is not convertible", () => {
    expect(() =>
      convertGeneratedPlanToPatchPlan(
        buildPlan({
          intent: "rename_symbol",
          operations: [
            {
              type: "rename_symbol",
              filePath: "src/example.ts",
              from: "oldName",
              to: "newName",
            },
          ],
        })
      )
    ).toThrow(
      '[UNSUPPORTED_INTENT] Cannot convert generated patch plan: Generated patch intent "rename_symbol" is not supported for PatchPlan conversion.'
    );
  });

  it("converts a supported safe_replace generated plan into PatchPlan", () => {
    const result = convertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [
          {
            type: "safe_replace",
            filePath: "src/example.ts",
            find: "oldText",
            replaceWith: "newText",
            matchMode: "exact",
          },
        ],
      })
    );

    expect(result).toEqual({
      operations: [
        {
          type: "replace",
          filePath: "src/example.ts",
          find: "oldText",
          replaceWith: "newText",
          matchMode: "exact",
        },
      ],
    });
  });
});