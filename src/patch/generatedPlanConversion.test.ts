import { describe, expect, it } from "vitest";
import {
  canConvertGeneratedPlanToPatchPlan,
  convertGeneratedPlanToPatchPlan,
  type GeneratedPatchPlan,
} from "./generatedPlanConversion.js";

function buildValidPlan(): GeneratedPatchPlan {
  return {
    intent: "replace_exact_text",
    operations: [
      {
        filePath: "src/example.ts",
        find: "oldText",
        replaceWith: "newText",
        matchMode: "exact",
      },
    ],
  };
}

describe("canConvertGeneratedPlanToPatchPlan", () => {
  it("rejects empty operations", () => {
    const plan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [],
    };

    expect(canConvertGeneratedPlanToPatchPlan(plan)).toEqual({
      canConvert: false,
      code: "EMPTY_OPERATIONS",
      reason: "Generated patch plan contains no operations.",
    });
  });

  it("rejects multiple operations", () => {
    const plan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [
        {
          filePath: "src/a.ts",
          find: "a",
          replaceWith: "b",
          matchMode: "exact",
        },
        {
          filePath: "src/b.ts",
          find: "c",
          replaceWith: "d",
          matchMode: "exact",
        },
      ],
    };

    expect(canConvertGeneratedPlanToPatchPlan(plan)).toEqual({
      canConvert: false,
      code: "MULTI_OPERATION_NOT_SUPPORTED",
      reason:
        "Generated patch plan contains multiple operations, but only a single operation is supported.",
    });
  });

  it("rejects unsupported intent", () => {
    const plan: GeneratedPatchPlan = {
      intent: "create_file",
      operations: [
        {
          filePath: "src/example.ts",
          find: "a",
          replaceWith: "b",
          matchMode: "exact",
        },
      ],
    };

    expect(canConvertGeneratedPlanToPatchPlan(plan)).toEqual({
      canConvert: false,
      code: "UNSUPPORTED_INTENT",
      reason:
        'Generated patch intent "create_file" is not supported for PatchPlan conversion.',
    });
  });

  it('rejects placeholder filePath "unknown"', () => {
    const plan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [
        {
          filePath: "unknown",
          find: "a",
          replaceWith: "b",
          matchMode: "exact",
        },
      ],
    };

    expect(canConvertGeneratedPlanToPatchPlan(plan)).toEqual({
      canConvert: false,
      code: "PLACEHOLDER_FILE_PATH",
      reason:
        'Generated patch operation contains placeholder filePath "unknown".',
    });
  });

  it('rejects placeholder find value "old_value"', () => {
    const plan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [
        {
          filePath: "src/example.ts",
          find: "old_value",
          replaceWith: "actual_value",
          matchMode: "exact",
        },
      ],
    };

    expect(canConvertGeneratedPlanToPatchPlan(plan)).toEqual({
      canConvert: false,
      code: "PLACEHOLDER_TEXT",
      reason:
        "Generated patch operation contains placeholder find/replace values.",
    });
  });

  it('rejects placeholder replaceWith value "new_value"', () => {
    const plan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [
        {
          filePath: "src/example.ts",
          find: "actual_value",
          replaceWith: "new_value",
          matchMode: "exact",
        },
      ],
    };

    expect(canConvertGeneratedPlanToPatchPlan(plan)).toEqual({
      canConvert: false,
      code: "PLACEHOLDER_TEXT",
      reason:
        "Generated patch operation contains placeholder find/replace values.",
    });
  });

  it("rejects non-exact match mode", () => {
    const plan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [
        {
          filePath: "src/example.ts",
          find: "oldText",
          replaceWith: "newText",
          matchMode: "substring",
        },
      ],
    };

    expect(canConvertGeneratedPlanToPatchPlan(plan)).toEqual({
      canConvert: false,
      code: "NON_EXACT_MATCH",
      reason:
        'Generated patch operation requires matchMode "exact", received "substring".',
    });
  });

  it("rejects no-op replacement", () => {
    const plan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [
        {
          filePath: "src/example.ts",
          find: "sameText",
          replaceWith: "sameText",
          matchMode: "exact",
        },
      ],
    };

    expect(canConvertGeneratedPlanToPatchPlan(plan)).toEqual({
      canConvert: false,
      code: "NO_OP_REPLACEMENT",
      reason:
        "Generated patch operation has no effect because find and replaceWith are identical.",
    });
  });

  it("returns canConvert true for a valid plan", () => {
    expect(canConvertGeneratedPlanToPatchPlan(buildValidPlan())).toEqual({
      canConvert: true,
    });
  });

  it("returns first deterministic failure when multiple rules are violated", () => {
    const plan: GeneratedPatchPlan = {
      intent: "unsupported_intent",
      operations: [],
    };

    expect(canConvertGeneratedPlanToPatchPlan(plan)).toEqual({
      canConvert: false,
      code: "EMPTY_OPERATIONS",
      reason: "Generated patch plan contains no operations.",
    });
  });
});

describe("convertGeneratedPlanToPatchPlan", () => {
  it("converts a valid generated plan into a PatchPlan", () => {
    expect(convertGeneratedPlanToPatchPlan(buildValidPlan())).toEqual({
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

  it("throws with structured failure details when conversion validation fails", () => {
    const invalidPlan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [
        {
          filePath: "unknown",
          find: "oldText",
          replaceWith: "newText",
          matchMode: "exact",
        },
      ],
    };

    expect(() => convertGeneratedPlanToPatchPlan(invalidPlan)).toThrow(
      '[PLACEHOLDER_FILE_PATH] Cannot convert generated patch plan: Generated patch operation contains placeholder filePath "unknown".'
    );
  });
});