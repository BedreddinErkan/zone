import { describe, expect, it } from "vitest";
import { canConvertGeneratedPlanToPatchPlan } from "./canConvertGeneratedPlanToPatchPlan.js";
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

describe("canConvertGeneratedPlanToPatchPlan", () => {
  it("returns EMPTY_OPERATIONS when operations are missing", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [],
      })
    );

    expect(result).toEqual({
      canConvert: false,
      code: "EMPTY_OPERATIONS",
      reason: "Generated patch plan contains no operations.",
    });
  });

  it("returns UNSUPPORTED_INTENT for rename_symbol intent", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
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
    );

    expect(result).toEqual({
      canConvert: false,
      code: "UNSUPPORTED_INTENT",
      reason:
        'Generated patch intent "rename_symbol" is not supported for PatchPlan conversion.',
    });
  });

  it("returns MULTI_OPERATION_NOT_SUPPORTED when more than one operation exists", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [
          {
            type: "safe_replace",
            filePath: "src/example.ts",
            find: "a",
            replaceWith: "b",
            matchMode: "exact",
          },
          {
            type: "safe_replace",
            filePath: "src/example.ts",
            find: "c",
            replaceWith: "d",
            matchMode: "exact",
          },
        ],
      })
    );

    expect(result).toEqual({
      canConvert: false,
      code: "MULTI_OPERATION_NOT_SUPPORTED",
      reason:
        "Generated patch plan contains multiple operations, but only a single operation is supported.",
    });
  });

  it("returns UNSUPPORTED_OPERATION when operation type is not safe_replace", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [
          {
            type: "add_comment",
            filePath: "src/example.ts",
            comment: "note",
            target: "line:1",
          },
        ],
      })
    );

    expect(result).toEqual({
      canConvert: false,
      code: "UNSUPPORTED_OPERATION",
      reason:
        'Generated patch operation "add_comment" is not supported for PatchPlan conversion.',
    });
  });

  it("returns MISSING_REQUIRED_FIELDS when filePath is empty", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [
          {
            type: "safe_replace",
            filePath: "",
            find: "oldText",
            replaceWith: "newText",
            matchMode: "exact",
          },
        ],
      })
    );

    expect(result).toEqual({
      canConvert: false,
      code: "MISSING_REQUIRED_FIELDS",
      reason: "Generated patch operation requires a non-empty filePath.",
    });
  });

  it("returns MISSING_REQUIRED_FIELDS when find is empty", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [
          {
            type: "safe_replace",
            filePath: "src/example.ts",
            find: "",
            replaceWith: "newText",
            matchMode: "exact",
          },
        ],
      })
    );

    expect(result).toEqual({
      canConvert: false,
      code: "MISSING_REQUIRED_FIELDS",
      reason: "Generated patch operation requires a non-empty find value.",
    });
  });

  it("returns PLACEHOLDER_FILE_PATH for placeholder file path", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [
          {
            type: "safe_replace",
            filePath: "unknown",
            find: "oldText",
            replaceWith: "newText",
            matchMode: "exact",
          },
        ],
      })
    );

    expect(result).toEqual({
      canConvert: false,
      code: "PLACEHOLDER_FILE_PATH",
      reason:
        'Generated patch operation contains placeholder filePath "unknown".',
    });
  });

  it("returns PLACEHOLDER_TEXT for placeholder values", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [
          {
            type: "safe_replace",
            filePath: "src/example.ts",
            find: "old_value",
            replaceWith: "newText",
            matchMode: "exact",
          },
        ],
      })
    );

    expect(result).toEqual({
      canConvert: false,
      code: "PLACEHOLDER_TEXT",
      reason:
        "Generated patch operation contains placeholder find/replace values.",
    });
  });

  it("returns NON_EXACT_MATCH when matchMode is not exact", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [
          {
            type: "safe_replace",
            filePath: "src/example.ts",
            find: "oldText",
            replaceWith: "newText",
            matchMode: "contains" as "exact",
          },
        ],
      })
    );

    expect(result).toEqual({
      canConvert: false,
      code: "NON_EXACT_MATCH",
      reason:
        'Generated patch operation requires matchMode "exact", received "contains".',
    });
  });

  it("returns NO_OP_REPLACEMENT when find and replaceWith are the same", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
      buildPlan({
        operations: [
          {
            type: "safe_replace",
            filePath: "src/example.ts",
            find: "sameText",
            replaceWith: "sameText",
            matchMode: "exact",
          },
        ],
      })
    );

    expect(result).toEqual({
      canConvert: false,
      code: "NO_OP_REPLACEMENT",
      reason:
        "Generated patch operation has no effect because find and replaceWith are identical.",
    });
  });

  it("returns canConvert true for a valid single exact safe_replace operation", () => {
    const result = canConvertGeneratedPlanToPatchPlan(
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
      canConvert: true,
    });
  });
});