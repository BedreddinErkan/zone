"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectPatchValidationIssues = collectPatchValidationIssues;
const node_path_1 = __importDefault(require("node:path"));
const PROTECTED_FILE_PATTERNS = [
    /^\.env(\..+)?$/i,
    /^package-lock\.json$/i,
    /^pnpm-lock\.yaml$/i,
    /^yarn\.lock$/i,
    /^dist\//i,
    /^node_modules\//i,
    /^\.git\//i,
    /^\.github\/workflows\//i,
];
function normalizeFilePath(filePath) {
    return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}
function isProtectedPath(filePath) {
    const normalized = normalizeFilePath(filePath);
    return PROTECTED_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}
function isPathOutsideRepo(targetPath, patchPath) {
    const resolvedTarget = node_path_1.default.resolve(targetPath);
    const resolvedPatch = node_path_1.default.resolve(targetPath, patchPath);
    const relative = node_path_1.default.relative(resolvedTarget, resolvedPatch);
    return relative.startsWith("..") || node_path_1.default.isAbsolute(relative);
}
function isValidatedTarget(patchPath, validatedFiles) {
    if (!validatedFiles || validatedFiles.length === 0) {
        return false;
    }
    const normalizedPatchPath = normalizeFilePath(patchPath);
    return validatedFiles.some((file) => normalizeFilePath(file) === normalizedPatchPath);
}
function isSuspiciousWidePatch(diff) {
    if (!diff) {
        return false;
    }
    const addedLines = diff
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removedLines = diff
        .split("\n")
        .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const changedLines = addedLines + removedLines;
    return changedLines >= 80;
}
function isSuspiciousCreateTarget(patchPath) {
    const normalized = normalizeFilePath(patchPath);
    return (normalized.startsWith("src/") === false &&
        normalized.startsWith("server/") === false &&
        normalized.startsWith("client/") === false &&
        normalized.startsWith("tests/") === false &&
        normalized.startsWith("scripts/") === false &&
        normalized.startsWith("docs/") === false);
}
function collectPatchValidationIssues(input) {
    const issues = [];
    if (!input.patchPlan.patches || input.patchPlan.patches.length === 0) {
        issues.push({
            code: "EMPTY_PATCH_PLAN",
            severity: "critical",
            message: "Patch plan is empty.",
        });
        return issues;
    }
    for (const patch of input.patchPlan.patches) {
        const normalizedPath = normalizeFilePath(patch.path);
        if (isPathOutsideRepo(input.targetPath, patch.path)) {
            issues.push({
                code: "PATH_OUTSIDE_REPO",
                severity: "critical",
                message: "Patch target path resolves outside the repository root.",
                path: normalizedPath,
            });
            continue;
        }
        if (isProtectedPath(normalizedPath)) {
            issues.push({
                code: "PROTECTED_FILE_WRITE",
                severity: "critical",
                message: "Patch attempts to modify a protected file or directory.",
                path: normalizedPath,
            });
        }
        if (!isValidatedTarget(normalizedPath, input.validatedFiles)) {
            issues.push({
                code: "UNVALIDATED_FILE_TARGET",
                severity: "warning",
                message: "Patch target was not present in validated file list.",
                path: normalizedPath,
            });
        }
        if (patch.operation === "create" && isSuspiciousCreateTarget(normalizedPath)) {
            issues.push({
                code: "UNSAFE_CREATE_TARGET",
                severity: "warning",
                message: "Patch creates a file in a non-standard or unexpected location.",
                path: normalizedPath,
            });
        }
        if (isSuspiciousWidePatch(patch.diff)) {
            issues.push({
                code: "SUSPICIOUS_WIDE_PATCH",
                severity: "warning",
                message: "Patch diff is unusually large and should be reviewed before apply.",
                path: normalizedPath,
            });
        }
    }
    return issues;
}
//# sourceMappingURL=patchValidationRules.js.map