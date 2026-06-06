/**
 * Directory ignore rules for the agent-facing file-search tools
 * (search_in_files, list_files, find_references).
 *
 * Two layers, applied by default:
 *   1. A hard denylist of VCS + build-output directories that should never be
 *      traversed (they dump large minified artifacts into the model's context —
 *      e.g. a grep match inside `apps/web/.next/server/chunks/679.js`).
 *   2. The target project's `.gitignore` (best-effort for the fast-glob paths;
 *      ripgrep already honours `.gitignore` natively).
 *
 * Each tool exposes an `include_ignored` escape hatch for the rare search that
 * must reach into these directories.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Hard denylist: directories never searched by default. Covers `.git` plus the
 * common JS/TS build outputs (`node_modules`, `.next`, `dist`, `build`,
 * `coverage`, `.turbo`).
 */
export const DENYLIST_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
];

/** fast-glob `ignore` patterns for the hard denylist. */
export function denylistGlobs(): string[] {
  return DENYLIST_DIRS.map((d) => `**/${d}/**`);
}

/**
 * A single ripgrep negated brace-glob excluding the denylist dirs, e.g.
 * `!**​/{.git,node_modules,.next,dist,build,coverage,.turbo}/**`. ripgrep already
 * skips `.gitignore`d and hidden paths by default; this guarantees the denylist
 * is honoured even when a project doesn't `.gitignore` its build output.
 */
export function ripgrepDenylistGlob(): string {
  return `!**/{${DENYLIST_DIRS.join(",")}}/**`;
}

/**
 * Best-effort: parse `<repoPath>/.gitignore` into fast-glob ignore patterns so
 * the fast-glob-backed tools respect it the way ripgrep does natively.
 *
 * Conservative by design — only plain path/dir entries are translated. Lines
 * that are comments, negations (`!...`), or contain glob metacharacters beyond a
 * leading/trailing slash are skipped (their semantics don't map cleanly onto
 * fast-glob and over-matching would hide real files). Never throws.
 */
export function gitignoreGlobs(repoPath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoPath, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    // Strip an optional leading/trailing slash (anchor / dir marker), then
    // require a plain name with no remaining glob metacharacters.
    const cleaned = line.replace(/^\//, "").replace(/\/$/, "");
    if (!cleaned || /[*?[\]{}!]/.test(cleaned)) continue;
    out.push(`**/${cleaned}/**`, `**/${cleaned}`);
  }
  return out;
}

/**
 * Compose the fast-glob `ignore` list for a tool invocation. When
 * `includeIgnored` is set (the escape hatch) nothing is excluded.
 */
export function buildFastGlobIgnore(repoPath: string, includeIgnored: boolean): string[] {
  if (includeIgnored) return [];
  return [...denylistGlobs(), ...gitignoreGlobs(repoPath)];
}
