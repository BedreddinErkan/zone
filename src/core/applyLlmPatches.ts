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

  for (const patch of patches) {
    if (patch.fullContent === "") {
      skipped.push(patch.filePath);
      continue;
    }

    const absolutePath = path.resolve(repoPath, patch.filePath);

    try {
      await fs.access(repoPath);
      const parentDir = path.dirname(absolutePath);
      const relativeParent = path.relative(repoPath, parentDir);
      const depthFromRepo = relativeParent.split(path.sep).filter(Boolean).length;

      if (depthFromRepo <= 1) {
        try {
          await fs.mkdir(parentDir);
        } catch (mkdirErr) {
          if ((mkdirErr as NodeJS.ErrnoException).code !== "EEXIST") {
            throw mkdirErr;
          }
        }
      } else {
        await fs.access(parentDir);
      }

      await fs.writeFile(absolutePath, patch.fullContent, "utf8");
      applied.push(patch.filePath);
    } catch {
      failed.push(patch.filePath);
    }
  }

  return { applied, skipped, failed };
}