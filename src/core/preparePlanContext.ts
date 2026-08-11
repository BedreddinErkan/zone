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
 * (which emitted every 5+ char task word). Measured against thirty-five
 * production tasks from one author's own sessions (dogfood and scratch repos,
 * not a user sample): median three terms, but the cap binds on roughly forty-
 * three percent of them (fifteen of thirty-five exceed eight), so it is not
 * the rare case the median alone suggests. The eight kept are the first by
 * extraction order — camelCase matches, then SCREAMING_SNAKE, then
 * snake_case, then quoted, each in task-text position — not the eight most
 * relevant by any score; a task with many terms can lose any of them to this
 * slice depending only on where they fall in that order.
 *
 * Delivered matches are ordered by per-file match count, descending, path
 * ascending as the tie-break, with the cap taken after that ordering rather
 * than during the walk. The counts come from the same rg invocation already
 * made for the match itself, at no measured additional cost. This makes the
 * capped selection deterministic where the walk-order draw it replaced was
 * not: on the one task with a known-correct file — a ceiling on which tasks
 * can be checked at all, not a small sample — it returned one distinct
 * sequence across ten repeats, against a walk-order draw that had delivered
 * the correct file on one of twenty and four of twenty runs. The tie-break
 * only ever adjudicates a small, local sub-selection — tied groups at the
 * cut point ran two to three files across the twenty-six tasks measured —
 * unlike the ranker's own ties, where the same path comparison is the
 * dominant selector.
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
      ["--count-matches", "--ignore-case", "--word-regexp", "--glob", "*.{ts,tsx,js,jsx,py,go,rb}", pattern, repoPath],
      { maxBuffer: 1024 * 512 },
    );
    const knownPaths = new Set(allFiles.map(f => f.path));
    const counted: Array<{ rel: string; count: number }> = [];
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const sep = line.lastIndexOf(":");
      if (sep === -1) continue;
      const abs = line.slice(0, sep);
      const count = Number(line.slice(sep + 1));
      const rel = path.relative(repoPath, abs);
      if (!rel.startsWith("..") && knownPaths.has(rel) && Number.isFinite(count)) {
        counted.push({ rel, count });
      }
    }
    counted.sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
    const result = new Set<string>();
    for (const { rel } of counted) {
      if (result.size >= cap) break;
      result.add(rel);
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
