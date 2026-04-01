import path from "node:path";
import type { LlmPatchPlan } from "../types/agent.js";
import type { PatchTargetCheckResult, PatchValidationIssue } from "../types/patch.js";
import { fileExists } from "../utils/files.js";

function isSupportedOperation(value: string): value is "create" | "modify" {
  return value === "create" || value === "modify";
}

export async function validatePatchPlan(input: {
  targetPath: string;
  patchPlan: LlmPatchPlan;
}): Promise<PatchTargetCheckResult> {
  const issues: PatchValidationIssue[] = [];
  const seenPaths = new Set<string>();

  for (const patch of input.patchPlan.patches) {
    if (!patch.path || !patch.path.trim()) {
      issues.push({
        level: "error",
        message: "Patch item is missing a target path."
      });
      continue;
    }

    if (!isSupportedOperation(patch.operation)) {
      issues.push({
        level: "error",
        message: `Unsupported patch operation '${patch.operation}'.`,
        filePath: patch.path
      });
      continue;
    }

    if (!patch.contentPreview || !patch.contentPreview.trim()) {
      issues.push({
        level: "warning",
        message: "Patch item has empty content preview.",
        filePath: patch.path
      });
    }

    const normalizedPath = patch.path.replace(/\\/g, "/");

    if (seenPaths.has(normalizedPath)) {
      issues.push({
        level: "warning",
        message: "Multiple patch items target the same file.",
        filePath: patch.path
      });
    } else {
      seenPaths.add(normalizedPath);
    }

    const absoluteTargetPath = path.join(input.targetPath, patch.path);
    const exists = await fileExists(absoluteTargetPath);

    if (patch.operation === "create" && exists) {
      issues.push({
        level: "warning",
        message: "Create operation targets an existing file.",
        filePath: patch.path
      });
    }

    if (patch.operation === "modify" && !exists) {
      issues.push({
        level: "error",
        message: "Modify operation targets a file that does not exist.",
        filePath: patch.path
      });
    }

    if (patch.path.includes("node_modules/") || patch.path.includes("\\node_modules\\")) {
      issues.push({
        level: "warning",
        message: "Patch targets a file inside node_modules, which is usually unintended.",
        filePath: patch.path
      });
    }

    if (patch.path.startsWith(".agent-patches") || patch.path.startsWith(".agent-backups")) {
      issues.push({
        level: "warning",
        message: "Patch targets an internal agent artifact directory.",
        filePath: patch.path
      });
    }
  }

  return {
    isValid: !issues.some((issue) => issue.level === "error"),
    issues
  };
}