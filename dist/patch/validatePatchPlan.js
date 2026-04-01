"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePatchPlan = validatePatchPlan;
const node_path_1 = __importDefault(require("node:path"));
const files_js_1 = require("../utils/files.js");
function isSupportedOperation(value) {
    return value === "create" || value === "modify";
}
function normalizePatchPath(filePath) {
    return filePath.replace(/\\/g, "/").trim();
}
function resolvePatchPath(targetPath, patchPath) {
    return node_path_1.default.resolve(targetPath, patchPath);
}
function isPathOutsideRepo(targetPath, patchPath) {
    const resolvedRepoRoot = node_path_1.default.resolve(targetPath);
    const resolvedPatchPath = resolvePatchPath(targetPath, patchPath);
    const relative = node_path_1.default.relative(resolvedRepoRoot, resolvedPatchPath);
    return relative.startsWith("..") || node_path_1.default.isAbsolute(relative);
}
function isProtectedFilePath(normalizedPath) {
    return (normalizedPath === ".env" ||
        normalizedPath.startsWith(".env.") ||
        normalizedPath === "package-lock.json" ||
        normalizedPath === "yarn.lock" ||
        normalizedPath === "pnpm-lock.yaml" ||
        normalizedPath.startsWith(".github/workflows/") ||
        normalizedPath.startsWith(".git/"));
}
function isNodeModulesPath(normalizedPath) {
    return normalizedPath.includes("node_modules/");
}
function isAgentArtifactPath(normalizedPath) {
    return (normalizedPath.startsWith(".agent-patches") ||
        normalizedPath.startsWith(".agent-backups") ||
        normalizedPath.startsWith(".agent-cache"));
}
function buildIssue(input) {
    return {
        level: input.level,
        code: input.code,
        message: input.message,
        filePath: input.filePath,
        details: input.details,
    };
}
async function validatePatchPlan(input) {
    const issues = [];
    const seenPaths = new Set();
    for (const patch of input.patchPlan.patches) {
        if (!patch.path || !patch.path.trim()) {
            issues.push(buildIssue({
                level: "error",
                code: "MISSING_TARGET_PATH",
                message: "Patch item is missing a target path.",
            }));
            continue;
        }
        const normalizedPath = normalizePatchPath(patch.path);
        if (!isSupportedOperation(patch.operation)) {
            issues.push(buildIssue({
                level: "error",
                code: "UNSUPPORTED_OPERATION",
                message: `Unsupported patch operation '${patch.operation}'.`,
                filePath: normalizedPath,
            }));
            continue;
        }
        if (!patch.contentPreview || !patch.contentPreview.trim()) {
            issues.push(buildIssue({
                level: "warning",
                code: "EMPTY_CONTENT_PREVIEW",
                message: "Patch item has empty content preview.",
                filePath: normalizedPath,
            }));
        }
        if (seenPaths.has(normalizedPath)) {
            issues.push(buildIssue({
                level: "warning",
                code: "DUPLICATE_TARGET_PATH",
                message: "Multiple patch items target the same file.",
                filePath: normalizedPath,
            }));
        }
        else {
            seenPaths.add(normalizedPath);
        }
        if (isPathOutsideRepo(input.targetPath, normalizedPath)) {
            issues.push(buildIssue({
                level: "error",
                code: "PATH_OUTSIDE_REPO",
                message: "Patch target resolves outside the repository root.",
                filePath: normalizedPath,
            }));
            continue;
        }
        if (isProtectedFilePath(normalizedPath)) {
            issues.push(buildIssue({
                level: "error",
                code: "TARGETS_PROTECTED_FILE",
                message: "Patch targets a protected file or workflow path.",
                filePath: normalizedPath,
            }));
        }
        const absoluteTargetPath = resolvePatchPath(input.targetPath, normalizedPath);
        const exists = await (0, files_js_1.fileExists)(absoluteTargetPath);
        if (patch.operation === "create" && exists) {
            issues.push(buildIssue({
                level: "warning",
                code: "CREATE_TARGET_ALREADY_EXISTS",
                message: "Create operation targets an existing file.",
                filePath: normalizedPath,
            }));
        }
        if (patch.operation === "modify" && !exists) {
            issues.push(buildIssue({
                level: "error",
                code: "MODIFY_TARGET_MISSING",
                message: "Modify operation targets a file that does not exist.",
                filePath: normalizedPath,
            }));
        }
        if (isNodeModulesPath(normalizedPath)) {
            issues.push(buildIssue({
                level: "warning",
                code: "TARGETS_NODE_MODULES",
                message: "Patch targets a file inside node_modules, which is usually unintended.",
                filePath: normalizedPath,
            }));
        }
        if (isAgentArtifactPath(normalizedPath)) {
            issues.push(buildIssue({
                level: "warning",
                code: "TARGETS_AGENT_ARTIFACT",
                message: "Patch targets an internal agent artifact directory.",
                filePath: normalizedPath,
            }));
        }
    }
    return {
        isValid: !issues.some((issue) => issue.level === "error"),
        issues,
    };
}
//# sourceMappingURL=validatePatchPlan.js.map