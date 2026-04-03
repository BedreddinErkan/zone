import type { GeneratedPlanConversionCheck } from "./generatedPlanConversionTypes.js";
import { getGeneratedPlanConversionFailureSummary } from "./generatedPlanConversionFailureMeta.js";

type Failure = Extract<
  GeneratedPlanConversionCheck,
  { canConvert: false }
>;

export function formatGeneratedPlanConversionFailure(
  failure: Failure
) {
  return {
    stage: "generated_patch_conversion",
    status: "blocked",
    summary: getGeneratedPlanConversionFailureSummary(failure.code),
    details: failure.reason,

    // existing fields (koru)
    canConvert: false,
    reasonCode: failure.code,
    applyStatus: "blocked"
  } as const;
}