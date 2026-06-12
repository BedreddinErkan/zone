import fs from "node:fs";
import path from "node:path";

export type DiffLine = {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNumber: number;
};

export type StagedFile = {
  path: string;
  findReplace: string;
  added: number;
  removed: number;
};

export function computeFileDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");
  const rows = beforeLines.length + 1;
  const cols = afterLines.length + 1;
  const lcs = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      if (beforeLines[i] === afterLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      diff.push({ type: "unchanged", content: afterLines[j], lineNumber: j + 1 });
      i += 1;
      j += 1;
      continue;
    }

    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      diff.push({
        type: "removed",
        content: beforeLines[i],
        lineNumber: Math.min(j + 1, afterLines.length + 1),
      });
      i += 1;
      continue;
    }

    diff.push({ type: "added", content: afterLines[j], lineNumber: j + 1 });
    j += 1;
  }

  while (i < beforeLines.length) {
    diff.push({
      type: "removed",
      content: beforeLines[i],
      lineNumber: Math.min(j + 1, afterLines.length + 1),
    });
    i += 1;
  }

  while (j < afterLines.length) {
    diff.push({ type: "added", content: afterLines[j], lineNumber: j + 1 });
    j += 1;
  }

  return diff;
}

// Hunk-grouping: maximal runs of removed/added lines split by unchanged → one FIND/REPLACE block each.
// Output is compatible with DiffView.tsx which parses "--- FIND ---"/"--- REPLACE ---" format.
export function diffToFindReplace(diff: DiffLine[]): string {
  const blocks: string[] = [];
  let rm: string[] = [];
  let add: string[] = [];
  const flush = (): void => {
    if (rm.length > 0 || add.length > 0) {
      blocks.push(`--- FIND ---\n${rm.join("\n")}\n--- REPLACE ---\n${add.join("\n")}`);
    }
    rm = [];
    add = [];
  };
  for (const l of diff) {
    if (l.type === "unchanged") {
      flush();
    } else if (l.type === "removed") {
      rm.push(l.content);
    } else {
      add.push(l.content);
    }
  }
  flush();
  return blocks.join("\n");
}

// Reads disk-original content (""  on ENOENT = new file), computes diff, builds StagedFile[].
// Called at checkpoint time when disk still holds the original content (before the flush loop).
export function buildStagedDiffs(
  stagingFiles: Map<string, string>,
  repoPath: string
): StagedFile[] {
  const result: StagedFile[] = [];
  for (const [abs, after] of stagingFiles) {
    let before = "";
    try {
      before = fs.readFileSync(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // ENOENT → new file, before = ""
    }
    const diff = computeFileDiff(before, after);
    const findReplace = diffToFindReplace(diff);
    const added = diff.filter((l) => l.type === "added").length;
    const removed = diff.filter((l) => l.type === "removed").length;
    result.push({
      path: path.relative(repoPath, abs) || abs,
      findReplace,
      added,
      removed,
    });
  }
  return result;
}

// Formats discarded staging as a "PRIOR STAGING ATTEMPT" block for injection into
// the first user message on a re-stage run. Uses diffToFindReplace per file.
// Never injected into assembleAgentSystemPrompt (cache breakpoint #2 invariant).
export function buildRestageSeedBlock(
  restageSeed: Map<string, string>,
  repoPath: string
): string {
  const files = buildStagedDiffs(restageSeed, repoPath);
  if (files.length === 0) return "";
  const lines: string[] = [
    "PRIOR STAGING ATTEMPT — the following changes were staged but not applied. Revise or replace them:",
    "",
  ];
  for (const f of files) {
    lines.push(`### ${f.path} (+${f.added}/-${f.removed})`);
    if (f.findReplace) lines.push(f.findReplace);
    lines.push("");
  }
  lines.push("END PRIOR STAGING ATTEMPT.");
  return lines.join("\n") + "\n\n";
}
