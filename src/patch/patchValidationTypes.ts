export type PatchValidationSeverity = "warning" | "critical";

export type PatchValidationIssueCode =
  | "EMPTY_PATCH_PLAN"
  | "PATCH_TARGET_MISSING"
  | "PATH_OUTSIDE_REPO"
  | "PROTECTED_FILE_WRITE"
  | "UNVALIDATED_FILE_TARGET"
  | "UNSAFE_CREATE_TARGET"
  | "SUSPICIOUS_WIDE_PATCH";

export interface PatchValidationIssue {
  code: PatchValidationIssueCode;
  severity: PatchValidationSeverity;
  message: string;
  path?: string;
  details?: string[];
}

export interface ValidatePatchPlanInput {
  targetPath: string;
  patchPlan: {
    patches: Array<{
      path: string;
      operation: "create" | "modify" | "delete";
      diff?: string;
      content?: string;
    }>;
  };
  validatedFiles?: string[];
}

export interface ValidatePatchPlanResult {
  ok: boolean;
  issues: PatchValidationIssue[];
}