import { execFile } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { scanRepo } from "../repo/scanRepo.js";
import { detectProjectStructure } from "../repo/detectProjectStructure.js";
import { rankRelevantFiles } from "../repo/rankRelevantFiles.js";
import type { RepoFile } from "../types/project.js";
import type { LLMProvider } from "../llm/types.js";

const execFileAsync = promisify(execFile);

/**
 * Grep the repo for code-like identifiers found in the task text, returning
 * relative paths of files that contain at least one match. Used to pre-seed
 * RELEVANT FILES with content-grounded matches that lexical ranking may miss
 * (e.g., rename tasks where the symbol name doesn't appear in the file path).
 * Fails safe — returns empty Set on any error (rg absent, timeout, etc.).
 */
async function grepMatchingFiles(
  task: string,
  allFiles: RepoFile[],
  repoPath: string,
  cap = 4,
): Promise<Set<string>> {
  const tokens = (task.match(/\b[A-Za-z][A-Za-z0-9_]{4,}\b/g) ?? [])
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 8);
  if (tokens.length === 0) return new Set();
  const pattern = tokens.join("|");
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--files-with-matches", "--glob", "*.{ts,tsx,js,jsx,py,go,rb}", pattern, repoPath],
      { maxBuffer: 1024 * 512 },
    );
    const knownPaths = new Set(allFiles.map(f => f.path));
    const result = new Set<string>();
    for (const abs of stdout.trim().split("\n")) {
      if (!abs) continue;
      const rel = path.relative(repoPath, abs);
      if (!rel.startsWith("..") && knownPaths.has(rel) && result.size < cap) {
        result.add(rel);
      }
    }
    return result;
  } catch {
    return new Set();
  }
}

export type PlanContext = {
  projectSummary: string;
  relevantFilePaths: string[];
  totalFileCount: number;
  rankedFileScores: Array<{ path: string; score: number }>;
  grepMatchedPaths: string[];
};

export async function preparePlanContext(input: {
  task: string;
  repoPath: string;
  repoSummaryOverride?: string;
  userApiKey?: string;
  provider?: LLMProvider;
  maxFiles?: number;
}): Promise<PlanContext> {
  const maxFiles = input.maxFiles ?? 8;

  let allFiles = await scanRepo(input.repoPath).catch(() => []);
  const totalFileCount = allFiles.length;

  const structure = detectProjectStructure(allFiles);
  const projectSummary =
    input.repoSummaryOverride ||
    structure.notes.join(" ") ||
    "No project summary available.";

  let relevantFilePaths: string[] = [];
  let rankedFileScores: Array<{ path: string; score: number }> = [];
  let grepMatchedPaths: string[] = [];
  if (allFiles.length > 0) {
    try {
      const ranked = await rankRelevantFiles({
        task: input.task,
        files: allFiles,
        readContent: async (relPath: string): Promise<string | null> => {
          try {
            return await readFile(path.join(input.repoPath, relPath), "utf-8");
          } catch {
            return null;
          }
        },
      });
      rankedFileScores = ranked.map((f) => ({ path: f.path, score: f.score }));
      const rankedPaths = ranked.slice(0, maxFiles).map((f) => f.path);
      const grepMatches = await grepMatchingFiles(input.task, allFiles, input.repoPath);
      grepMatchedPaths = [...grepMatches];
      const extra = [...grepMatches].filter(p => !rankedPaths.includes(p)).slice(0, 4);
      relevantFilePaths = [...rankedPaths, ...extra];
    } catch {
      // best-effort
    }
  }

  return { projectSummary, relevantFilePaths, totalFileCount, rankedFileScores, grepMatchedPaths };
}
