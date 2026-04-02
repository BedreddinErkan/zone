export type GeneratedPatchIntent = "replace_exact_text" | string;

export type GeneratedPatchMatchMode = "exact" | string;

export type GeneratedPatchOperation = {
  filePath: string;
  find: string;
  replaceWith: string;
  matchMode: GeneratedPatchMatchMode;
};

export type GeneratedPatchPlan = {
  intent: GeneratedPatchIntent;
  operations: GeneratedPatchOperation[];
};

export type PatchOperation = {
  type: "replace";
  filePath: string;
  find: string;
  replaceWith: string;
  matchMode: "exact";
};

export type PatchPlan = {
  operations: PatchOperation[];
};

export type GeneratedPlanConversionFailureCode =
  | "EMPTY_OPERATIONS"
  | "MULTI_OPERATION_NOT_SUPPORTED"
  | "UNSUPPORTED_INTENT"
  | "PLACEHOLDER_FILE_PATH"
  | "PLACEHOLDER_TEXT"
  | "NON_EXACT_MATCH"
  | "NO_OP_REPLACEMENT";

export type GeneratedPlanConversionCheck =
  | { canConvert: true }
  | {
      canConvert: false;
      code: GeneratedPlanConversionFailureCode;
      reason: string;
    };

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

function isSupportedIntent(intent: GeneratedPatchIntent): boolean {
  return intent === "replace_exact_text";
}

function isPlaceholderFilePath(filePath: string): boolean {
  return filePath === "unknown";
}

function hasPlaceholderText(operation: GeneratedPatchOperation): boolean {
  return (
    operation.find === "old_value" || operation.replaceWith === "new_value"
  );
}

/**
 * Strict deterministic validation gate for generated-plan -> PatchPlan conversion.
 *
 * Rules:
 * 1. operations must not be empty
 * 2. only a single operation is supported
 * 3. intent must be supported
 * 4. filePath must not be placeholder
 * 5. find/replaceWith must not contain placeholder values
 * 6. matchMode must be exact
 * 7. find and replaceWith must not be identical
 *
 * Validation order is fixed and deterministic.
 */
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

  if (!isSupportedIntent(plan.intent)) {
    return fail(
      "UNSUPPORTED_INTENT",
      `Generated patch intent "${plan.intent}" is not supported for PatchPlan conversion.`
    );
  }

  const operation = plan.operations[0];

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

/**
 * Converts a validated generated patch plan into a strict PatchPlan.
 *
 * Notes:
 * - This function assumes validation already passed.
 * - It still defensively re-checks conversion invariants.
 * - It never guesses or infers missing data.
 * - It throws on invalid input to prevent unsafe apply behavior.
 */
export function convertGeneratedPlanToPatchPlan(
  plan: GeneratedPatchPlan
): PatchPlan {
  const validation = canConvertGeneratedPlanToPatchPlan(plan);

  if (!validation.canConvert) {
    throw new Error(
      `[${validation.code}] Cannot convert generated patch plan: ${validation.reason}`
    );
  }

  if (plan.operations.length !== 1) {
    throw new Error(
      "Invariant violation: validated generated patch plan must contain exactly one operation."
    );
  }

  const operation = plan.operations[0];

  if (plan.intent !== "replace_exact_text") {
    throw new Error(
      `Invariant violation: expected supported intent "replace_exact_text", received "${plan.intent}".`
    );
  }

  if (operation.matchMode !== "exact") {
    throw new Error(
      `Invariant violation: expected matchMode "exact", received "${operation.matchMode}".`
    );
  }

  return {
    operations: [
      {
        type: "replace",
        filePath: operation.filePath,
        find: operation.find,
        replaceWith: operation.replaceWith,
        matchMode: "exact",
      },
    ],
  };
}