import type {
  GeneratedPatchPlan,
  GeneratedPatchOperation,
} from "../../patch-generation/generatedPatchPlanTypes.js";

export type { GeneratedPatchPlan, GeneratedPatchOperation };

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
  | "UNSUPPORTED_OPERATION"
  | "PLACEHOLDER_FILE_PATH"
  | "PLACEHOLDER_TEXT"
  | "MISSING_REQUIRED_FIELDS"
  | "NON_EXACT_MATCH"
  | "NO_OP_REPLACEMENT";

export type GeneratedPlanConversionCheck =
  | { canConvert: true }
  | {
      canConvert: false;
      code: GeneratedPlanConversionFailureCode;
      reason: string;
    };