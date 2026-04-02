import {
  canConvertGeneratedPlanToPatchPlan,
  convertGeneratedPlanToPatchPlan,
  type GeneratedPatchPlan,
  type PatchPlan,
} from "../patch/generatedPlanConversion.js";

export type GeneratedPatchPlanFlowResult =
  | {
      ok: true;
      patchPlan: PatchPlan;
      preview: string;
    }
  | {
      ok: false;
      preview: string;
      code: string;
      reason: string;
    };

export function runGeneratedPatchPlanFlow(args: {
  generatedPlan: GeneratedPatchPlan;
  preview: string;
}): GeneratedPatchPlanFlowResult {
  const { generatedPlan, preview } = args;

  const validation = canConvertGeneratedPlanToPatchPlan(generatedPlan);

  if (!validation.canConvert) {
    return {
      ok: false,
      preview,
      code: validation.code,
      reason: validation.reason,
    };
  }

  const patchPlan = convertGeneratedPlanToPatchPlan(generatedPlan);

  return {
    ok: true,
    preview,
    patchPlan,
  };
}