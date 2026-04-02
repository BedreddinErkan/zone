import type {
  GeneratedPatchOperation,
  GeneratedPatchPlan,
  GeneratedPlanConversionCheck,
  GeneratedPlanConversionFailureCode,
} from "./generatedPlanConversionTypes.js";

type SafeReplaceOperation = Extract<
  GeneratedPatchOperation,
  {
    type: "safe_replace";
  }
>;

function fail(
  code: GeneratedPlanConversionFailureCode,
  reason: string
): GeneratedPlanConversionCheck {
  return {
    canConvert: false,
    code,
    reason,
  };
}

function isSafeReplaceOperation(
  operation: GeneratedPatchOperation
): operation is SafeReplaceOperation {
  return operation.type === "safe_replace";
}

function isPlaceholderFilePath(filePath: string): boolean {
  return filePath === "unknown";
}

function hasPlaceholderText(operation: SafeReplaceOperation): boolean {
  return (
    operation.find === "old_value" || operation.replaceWith === "new_value"
  );
}

export function canConvertGeneratedPlanToPatchPlan(
  plan: GeneratedPatchPlan
): GeneratedPlanConversionCheck {
  if (plan.operations.length === 0) {
    return fail(
      "EMPTY_OPERATIONS",
      "Generated patch plan contains no operations."
    );
  }

  if (plan.operations.length > 1) {
    return fail(
      "MULTI_OPERATION_NOT_SUPPORTED",
      "Generated patch plan contains multiple operations, but only a single operation is supported."
    );
  }

  if (plan.intent !== "safe_replace") {
    return fail(
      "UNSUPPORTED_INTENT",
      `Generated patch intent "${plan.intent}" is not supported for PatchPlan conversion.`
    );
  }

  const operation = plan.operations[0];

  if (!isSafeReplaceOperation(operation)) {
    return fail(
      "UNSUPPORTED_OPERATION",
      `Generated patch operation "${operation.type}" is not supported for PatchPlan conversion.`
    );
  }

  if (!operation.filePath.trim()) {
    return fail(
      "MISSING_REQUIRED_FIELDS",
      "Generated patch operation requires a non-empty filePath."
    );
  }

  if (!operation.find.trim()) {
    return fail(
      "MISSING_REQUIRED_FIELDS",
      "Generated patch operation requires a non-empty find value."
    );
  }

  if (!operation.replaceWith.trim()) {
    return fail(
      "MISSING_REQUIRED_FIELDS",
      "Generated patch operation requires a non-empty replaceWith value."
    );
  }

  if (isPlaceholderFilePath(operation.filePath)) {
    return fail(
      "PLACEHOLDER_FILE_PATH",
      'Generated patch operation contains placeholder filePath "unknown".'
    );
  }

  if (hasPlaceholderText(operation)) {
    return fail(
      "PLACEHOLDER_TEXT",
      "Generated patch operation contains placeholder find/replace values."
    );
  }

  if (operation.matchMode !== "exact") {
    return fail(
      "NON_EXACT_MATCH",
      `Generated patch operation requires matchMode "exact", received "${operation.matchMode}".`
    );
  }

  if (operation.find === operation.replaceWith) {
    return fail(
      "NO_OP_REPLACEMENT",
      "Generated patch operation has no effect because find and replaceWith are identical."
    );
  }

  return { canConvert: true };
}