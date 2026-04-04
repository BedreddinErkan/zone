"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePatchValidationIssues = normalizePatchValidationIssues;
exports.normalizeSchemaValidationIssues = normalizeSchemaValidationIssues;
exports.normalizePatchRiskWarnings = normalizePatchRiskWarnings;
exports.normalizeArchitectureWarnings = normalizeArchitectureWarnings;
/**
 * Normalize functions for ValidationIssue production.
 * Shared by runFeatureAgent.ts and saveAgentResult.ts to ensure
 * consistent source/code/severity assignment across the pipeline.
 */
function normalizePatchValidationIssues(issues) {
    return issues.map((issue) => ({
        code: issue.level === "error"
            ? "PATCH_VALIDATION_ERROR"
            : "PATCH_VALIDATION_WARNING",
        message: issue.message,
        severity: issue.level,
        source: "patch",
        file: issue.filePath
    }));
}
function normalizeSchemaValidationIssues(issues) {
    return issues.map((issue) => ({
        code: issue.level === "error"
            ? "SCHEMA_VALIDATION_ERROR"
            : "SCHEMA_VALIDATION_WARNING",
        message: issue.message,
        severity: issue.level,
        source: "schema",
        file: issue.filePath
    }));
}
function normalizePatchRiskWarnings(warnings) {
    return warnings.map((message) => ({
        code: "PATCH_RISK_WARNING",
        message,
        severity: "warning",
        source: "patch"
    }));
}
function normalizeArchitectureWarnings(warnings) {
    return warnings.map((message) => ({
        code: "ARCHITECTURE_WARNING",
        message,
        severity: "warning",
        source: "architecture"
    }));
}
//# sourceMappingURL=normalizeIssues.js.map