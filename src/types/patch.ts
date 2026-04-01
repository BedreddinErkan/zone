export type PatchValidationIssue = {
  level: "warning" | "error";
  message: string;
  filePath?: string;
};

export type PatchTargetCheckResult = {
  isValid: boolean;
  issues: PatchValidationIssue[];
};