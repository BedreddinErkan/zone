import { promises as fs } from "node:fs";
import path from "node:path";
import { checkPathBoundary } from "../tools/toolExecutor.js";

export interface ApplyLlmPatchesResult {
  applied: string[];
  skipped: string[];
  failed: string[];
}

export async function applyLlmPatches(
  patches: Array<{ filePath: string; fullContent: string }>,
  repoPath: string
): Promise<ApplyLlmPatchesResult> {
  const PROTECTED_PATHS = ["src/ui/index.html", "src/ui/"];
  const applied: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  const resolvedRepo = path.resolve(repoPath);

  for (const patch of patches) {
    if (patch.fullContent === "") {
      skipped.push(patch.filePath);
      continue;
    }

    if (PROTECTED_PATHS.some((p) => patch.filePath.startsWith(p))) {
      failed.push(patch.filePath);
      continue;
    }

    const absolutePath = path.resolve(repoPath, patch.filePath);

    try {
      await fs.access(resolvedRepo);

      // Item 301: was a lexical string.startsWith(...) here, symlink-blind — a
      // constructed in-repo symlink escaped it. checkPathBoundary realpaths
      // both sides and fails closed when the boundary can't be resolved (a
      // broken symlink target, an unreadable directory in the chain). This is
      // a point-in-time check: it proves the target does not resolve outside
      // the repo AT THIS INSTANT, not for the remainder of this call — see
      // docs/deferred-work.md for the gap between here and the write below.
      if (checkPathBoundary(absolutePath, repoPath, "applyLlmPatches") === "escape") {
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
