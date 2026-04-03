import type { ValidationIssue } from "../types/agent.js";

/**
 * Normalize functions for ValidationIssue production.
 * Shared by runFeatureAgent.ts and saveAgentResult.ts to ensure
 * consistent source/code/severity assignment across the pipeline.
 */

export function normalizePatchValidationIssues(
  issues: Array<{
    level: "warning" | "error";
    message: string;
    filePath?: string;
  }>
): ValidationIssue[] {
  return issues.map((issue) => ({
    code:
      issue.level === "error"
        ? "PATCH_VALIDATION_ERROR"
        : "PATCH_VALIDATION_WARNING",
    message: issue.message,
    severity: issue.level,
    source: "patch" as const,
    file: issue.filePath
  }));
}

export function normalizeSchemaValidationIssues(
  issues: Array<{
    level: "warning" | "error";
    message: string;
    filePath?: string;
  }>
): ValidationIssue[] {
  return issues.map((issue) => ({
    code:
      issue.level === "error"
        ? "SCHEMA_VALIDATION_ERROR"
        : "SCHEMA_VALIDATION_WARNING",
    message: issue.message,
    severity: issue.level,
    source: "schema" as const,
    file: issue.filePath
  }));
}

export function normalizePatchRiskWarnings(warnings: string[]): ValidationIssue[] {
  return warnings.map((message) => ({
    code: "PATCH_RISK_WARNING",
    message,
    severity: "warning" as const,
    source: "patch" as const
  }));
}

export function normalizeArchitectureWarnings(warnings: string[]): ValidationIssue[] {
  return warnings.map((message) => ({
    code: "ARCHITECTURE_WARNING",
    message,
    severity: "warning" as const,
    source: "architecture" as const
  }));
}
