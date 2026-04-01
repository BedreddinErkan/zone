export type PatchValidationLevel = "warning" | "error";

export type PatchValidationIssueCode =
  | "MISSING_TARGET_PATH"
  | "UNSUPPORTED_OPERATION"
  | "EMPTY_CONTENT_PREVIEW"
  | "DUPLICATE_TARGET_PATH"
  | "CREATE_TARGET_ALREADY_EXISTS"
  | "MODIFY_TARGET_MISSING"
  | "TARGETS_NODE_MODULES"
  | "TARGETS_AGENT_ARTIFACT"
  | "PATH_OUTSIDE_REPO"
  | "TARGETS_PROTECTED_FILE"
  | "SCHEMA_SNAPSHOT_MISSING"
  | "SCHEMA_PATH_NOT_FOUND"
  | "SCHEMA_FIELD_MISMATCH";

export interface PatchValidationIssue {
  level: PatchValidationLevel;
  code: PatchValidationIssueCode;
  message: string;
  filePath?: string;
  details?: string[];
}

export interface PatchTargetCheckResult {
  isValid: boolean;
  issues: PatchValidationIssue[];
}