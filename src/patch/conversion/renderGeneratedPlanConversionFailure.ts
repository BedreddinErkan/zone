import type { GeneratedPlanConversionCheck } from "./generatedPlanConversionTypes.js";
import { getGeneratedPlanConversionFailureSummary } from "./generatedPlanConversionFailureMeta.js";

type GeneratedPlanConversionFailure = Extract<
  GeneratedPlanConversionCheck,
  { canConvert: false }
>;

export function renderGeneratedPlanConversionFailure(
  failure: GeneratedPlanConversionFailure
): string {
  return [
    "=== GENERATED PATCH PLAN CONVERSION ===",
    "Status: failed",
    `Reason code: ${failure.code}`,
    `Summary: ${getGeneratedPlanConversionFailureSummary(failure.code)}`,
    `Details: ${failure.reason}`,
    "Apply status: blocked",
    "No changes were applied."
  ].join("\n");
}