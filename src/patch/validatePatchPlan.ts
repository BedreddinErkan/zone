import path from "node:path";
import type { LlmPatchPlan } from "../types/agent.js";
import type {
  PatchTargetCheckResult,
  PatchValidationIssue,
} from "../types/patch.js";
import { fileExists } from "../utils/files.js";

function isSupportedOperation(value: string): value is "create" | "modify" {
  return value === "create" || value === "modify";
}

function normalizePatchPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").trim();
}

function resolvePatchPath(targetPath: string, patchPath: string): string {
  return path.resolve(targetPath, patchPath);
}

function isPathOutsideRepo(targetPath: string, patchPath: string): boolean {
  const resolvedRepoRoot = path.resolve(targetPath);
  const resolvedPatchPath = resolvePatchPath(targetPath, patchPath);
  const relative = path.relative(resolvedRepoRoot, resolvedPatchPath);

  return relative.startsWith("..") || path.isAbsolute(relative);
}

function isProtectedFilePath(normalizedPath: string): boolean {
  return (
    normalizedPath === ".env" ||
    normalizedPath.startsWith(".env.") ||
    normalizedPath === "package-lock.json" ||
    normalizedPath === "yarn.lock" ||
    normalizedPath === "pnpm-lock.yaml" ||
    normalizedPath.startsWith(".github/workflows/") ||
    normalizedPath.startsWith(".git/")
  );
}

function isNodeModulesPath(normalizedPath: string): boolean {
  return normalizedPath.includes("node_modules/");
}

function isAgentArtifactPath(normalizedPath: string): boolean {
  return (
    normalizedPath.startsWith(".agent-patches") ||
    normalizedPath.startsWith(".agent-backups") ||
    normalizedPath.startsWith(".agent-cache")
  );
}

function buildIssue(input: {
  level: "warning" | "error";
  code:
    | "MISSING_TARGET_PATH"
    | "UNSUPPORTED_OPERATION"
    | "EMPTY_CONTENT_PREVIEW"
    | "DUPLICATE_TARGET_PATH"
    | "CREATE_TARGET_ALREADY_EXISTS"
    | "MODIFY_TARGET_MISSING"
    | "TARGETS_NODE_MODULES"
    | "TARGETS_AGENT_ARTIFACT"
    | "PATH_OUTSIDE_REPO"
    | "TARGETS_PROTECTED_FILE";
  message: string;
  filePath?: string;
  details?: string[];
}): PatchValidationIssue {
  return {
    level: input.level,
    code: input.code,
    message: input.message,
    filePath: input.filePath,
    details: input.details,
  };
}

export async function validatePatchPlan(input: {
  targetPath: string;
  patchPlan: LlmPatchPlan;
}): Promise<PatchTargetCheckResult> {
  const issues: PatchValidationIssue[] = [];
  const seenPaths = new Set<string>();

  for (const patch of input.patchPlan.patches) {
    if (!patch.path || !patch.path.trim()) {
      issues.push(
        buildIssue({
          level: "error",
          code: "MISSING_TARGET_PATH",
          message: "Patch item is missing a target path.",
        })
      );
      continue;
    }

    const normalizedPath = normalizePatchPath(patch.path);

    if (!isSupportedOperation(patch.operation)) {
      issues.push(
        buildIssue({
          level: "error",
          code: "UNSUPPORTED_OPERATION",
          message: `Unsupported patch operation '${patch.operation}'.`,
          filePath: normalizedPath,
        })
      );
      continue;
    }

    if (!patch.contentPreview || !patch.contentPreview.trim()) {
      issues.push(
        buildIssue({
          level: "warning",
          code: "EMPTY_CONTENT_PREVIEW",
          message: "Patch item has empty content preview.",
          filePath: normalizedPath,
        })
      );
    }

    if (seenPaths.has(normalizedPath)) {
      issues.push(
        buildIssue({
          level: "warning",
          code: "DUPLICATE_TARGET_PATH",
          message: "Multiple patch items target the same file.",
          filePath: normalizedPath,
        })
      );
    } else {
      seenPaths.add(normalizedPath);
    }

    if (isPathOutsideRepo(input.targetPath, normalizedPath)) {
      issues.push(
        buildIssue({
          level: "error",
          code: "PATH_OUTSIDE_REPO",
          message: "Patch target resolves outside the repository root.",
          filePath: normalizedPath,
        })
      );
      continue;
    }

    if (isProtectedFilePath(normalizedPath)) {
      issues.push(
        buildIssue({
          level: "error",
          code: "TARGETS_PROTECTED_FILE",
          message: "Patch targets a protected file or workflow path.",
          filePath: normalizedPath,
        })
      );
    }

    const absoluteTargetPath = resolvePatchPath(input.targetPath, normalizedPath);
    const exists = await fileExists(absoluteTargetPath);

    if (patch.operation === "create" && exists) {
      issues.push(
        buildIssue({
          level: "warning",
          code: "CREATE_TARGET_ALREADY_EXISTS",
          message: "Create operation targets an existing file.",
          filePath: normalizedPath,
        })
      );
    }

    if (patch.operation === "modify" && !exists) {
      issues.push(
        buildIssue({
          level: "error",
          code: "MODIFY_TARGET_MISSING",
          message: "Modify operation targets a file that does not exist.",
          filePath: normalizedPath,
        })
      );
    }

    if (isNodeModulesPath(normalizedPath)) {
      issues.push(
        buildIssue({
          level: "warning",
          code: "TARGETS_NODE_MODULES",
          message:
            "Patch targets a file inside node_modules, which is usually unintended.",
          filePath: normalizedPath,
        })
      );
    }

    if (isAgentArtifactPath(normalizedPath)) {
      issues.push(
        buildIssue({
          level: "warning",
          code: "TARGETS_AGENT_ARTIFACT",
          message: "Patch targets an internal agent artifact directory.",
          filePath: normalizedPath,
        })
      );
    }
  }

  return {
    isValid: !issues.some((issue) => issue.level === "error"),
    issues,
  };
}