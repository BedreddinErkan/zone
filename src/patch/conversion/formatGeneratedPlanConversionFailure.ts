import type { GeneratedPlanConversionCheck } from "./generatedPlanConversionTypes.js";
import { getGeneratedPlanConversionFailureSummary } from "./generatedPlanConversionFailureMeta.js";

type GeneratedPlanConversionFailure = Extract<
  GeneratedPlanConversionCheck,
  { canConvert: false }
>;

export function formatGeneratedPlanConversionFailure(
  failure: GeneratedPlanConversionFailure
) {
  return {
    stage: "generated_patch_plan_conversion",
    status: "failed",
    canConvert: false,
    reasonCode: failure.code,
    summary: getGeneratedPlanConversionFailureSummary(failure.code),
    details: failure.reason,
    applyStatus: "blocked"
  } as const;
}