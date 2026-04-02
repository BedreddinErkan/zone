export const GENERATED_PLAN_CONVERSION_FAILURE_META = {
  EMPTY_OPERATIONS: {
    summary: "Generated plan contains no operations."
  },
  MULTIPLE_OPERATIONS_UNSUPPORTED: {
    summary: "Generated plan contains multiple operations, which is not supported."
  },
  UNSUPPORTED_INTENT: {
    summary: "Generated plan intent is not allowed for deterministic conversion."
  },
  UNSUPPORTED_OPERATION_TYPE: {
    summary: "Generated plan operation type is not supported."
  },
  PLACEHOLDER_FILE_PATH: {
    summary: "Generated plan file path contains a placeholder value."
  },
  PLACEHOLDER_TEXT: {
    summary: "Generated plan text contains a placeholder value."
  },
  MISSING_REQUIRED_FIELDS: {
    summary: "Generated plan is missing required fields."
  },
  INVALID_MATCH_MODE: {
    summary: "Generated plan match mode is invalid."
  },
  NO_OP_REPLACEMENT: {
    summary: "Generated plan replacement would not change file contents."
  }
} as const;

export type GeneratedPlanConversionFailureCode =
  keyof typeof GENERATED_PLAN_CONVERSION_FAILURE_META;

export function getGeneratedPlanConversionFailureSummary(
  code: string
): string {
  if (code in GENERATED_PLAN_CONVERSION_FAILURE_META) {
    return GENERATED_PLAN_CONVERSION_FAILURE_META[
      code as GeneratedPlanConversionFailureCode
    ].summary;
  }

  return "Generated plan conversion failed.";
}