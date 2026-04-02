import { promises as fs } from "node:fs";
import type { ApplyResult } from "./types.js";
import type { PatchPlan } from "./patchPlan.js";

export async function applyPatchPlan(plan: PatchPlan): Promise<ApplyResult> {
  const filesChanged: string[] = [];

  for (const patch of plan.patches) {
    await fs.writeFile(patch.filePath, patch.nextContent, "utf8");
    filesChanged.push(patch.filePath);
  }

  return {
    applied: true,
    filesChanged,
    summary: `Applied ${filesChanged.length} file change(s).`
  };
}