import { canConvertGeneratedPlanToPatchPlan } from "./canConvertGeneratedPlanToPatchPlan.js";
import type {
  GeneratedPatchOperation,
  GeneratedPatchPlan,
  PatchPlan,
} from "./generatedPlanConversionTypes.js";

export type { PatchPlan } from "./generatedPlanConversionTypes.js";

type SafeReplaceOperation = Extract<
  GeneratedPatchOperation,
  {
    type: "safe_replace";
  }
>;

function assertSafeReplaceOperation(
  operation: GeneratedPatchOperation
): asserts operation is SafeReplaceOperation {
  if (operation.type !== "safe_replace") {
    throw new Error(
      `Invariant violation: expected "safe_replace" operation, received "${operation.type}".`
    );
  }
}

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

  if (plan.intent !== "safe_replace") {
    throw new Error(
      `Invariant violation: expected supported intent "safe_replace", received "${plan.intent}".`
    );
  }

  const operation = plan.operations[0];
  assertSafeReplaceOperation(operation);

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