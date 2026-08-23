import { promises as fs } from "node:fs";
import path from "node:path";
import type { ApplyResult } from "./types.js";
import type { PatchPlan } from "./patchPlan.js";
import { checkPathBoundary } from "../tools/toolExecutor.js";

export async function applyPatchPlan(plan: PatchPlan, repoPath: string): Promise<ApplyResult> {
  const filesChanged: string[] = [];

  for (const patch of plan.patches) {
    const absolutePath = path.resolve(repoPath, patch.filePath);

    if (checkPathBoundary(absolutePath, repoPath, "applyPatchPlan") === "escape") {
      throw new Error(`Patch target resolves outside the repository: ${patch.filePath}`);
    }

    await fs.writeFile(absolutePath, patch.nextContent, "utf8");
    filesChanged.push(patch.filePath);
  }

  return {
    applied: true,
    filesChanged,
    summary: `Applied ${filesChanged.length} file change(s).`
  };
}