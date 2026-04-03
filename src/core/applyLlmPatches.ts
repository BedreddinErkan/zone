import { promises as fs } from "node:fs";
import path from "node:path";

export interface ApplyLlmPatchesResult {
  applied: string[];
  skipped: string[];
  failed: string[];
}

export async function applyLlmPatches(
  patches: Array<{ filePath: string; fullContent: string }>,
  repoPath: string
): Promise<ApplyLlmPatchesResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  const resolvedRepo = path.resolve(repoPath);

  for (const patch of patches) {
    if (patch.fullContent === "") {
      skipped.push(patch.filePath);
      continue;
    }

    const absolutePath = path.resolve(repoPath, patch.filePath);

    try {
      await fs.access(resolvedRepo);

      const isInsideRepo = absolutePath.startsWith(resolvedRepo + path.sep) ||
                           absolutePath === resolvedRepo;

      if (!isInsideRepo) {
        throw new Error("Path outside repo");
      }

      const parentDir = path.dirname(absolutePath);
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(absolutePath, patch.fullContent, "utf8");
      applied.push(patch.filePath);
    } catch {
      failed.push(patch.filePath);
    }
  }

  return { applied, skipped, failed };
}