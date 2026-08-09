import { execFile } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { scanRepo } from "../repo/scanRepo.js";
import { detectProjectStructure } from "../repo/detectProjectStructure.js";
import { rankRelevantFiles, extractEntityTerms } from "../repo/rankRelevantFiles.js";
import type { RepoFile } from "../types/project.js";
import type { LLMProvider } from "../llm/types.js";

const execFileAsync = promisify(execFile);

/**
 * Grep the repo for entity-shaped identifiers found in the task text (via
 * extractEntityTerms — the same extractor the ranker's own lexical boost
 * uses), returning relative paths of files that contain at least one match.
 * Used to pre-seed RELEVANT FILES with content-grounded matches that lexical
 * ranking may miss (e.g., rename tasks where the symbol name doesn't appear
 * in the file path). Fails safe — returns empty Set on any error (rg absent,
 * timeout, etc.), and returns empty immediately when the task carries no
 * identifier-shaped term (a plain-English task has nothing to grep for).
 *
 * --ignore-case is required, not optional: extractEntityTerms lowercases
 * every term it returns, so an uppercase identifier in source (SCREAMING_CASE
 * constants, PascalCase symbols) would never match without it. --word-regexp
 * excludes substring hits (e.g. a short term matching inside a longer,
 * unrelated identifier).
 *
 * The 8-term slice below is inherited from the prior word-tokeniser's sizing
 * (which emitted every 5+ char task word) and is not a measured bound on this
 * extractor — extractEntityTerms's four shape-restricted branches typically
 * return far fewer terms (1-3 on measured tasks), so this cap rarely binds.
 */
async function grepMatchingFiles(
  task: string,
  allFiles: RepoFile[],
  repoPath: string,
  cap = 4,
): Promise<Set<string>> {
  const tokens = extractEntityTerms(task).slice(0, 8);
  if (tokens.length === 0) return new Set();
  const pattern = tokens.join("|");
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--files-with-matches", "--ignore-case", "--word-regexp", "--glob", "*.{ts,tsx,js,jsx,py,go,rb}", pattern, repoPath],
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
