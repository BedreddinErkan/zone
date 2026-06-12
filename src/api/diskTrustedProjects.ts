import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, statSync } from "node:fs";
import { join, dirname, sep, resolve } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { classifyPath } from "../core/pathSafety.js";

export interface TrustedProject {
  path: string;
  trustedAt: string;
  trustedBy: "user" | "flag" | "env";
}

export interface TrustedProjectsFile {
  version: 1;
  projects: TrustedProject[];
}

let _trustedProjectsPathOverride: string | null = null;

/** For test isolation only — redirect where trusted-projects are stored. */
export function _setTrustedProjectsPathForTest(p: string | null): void {
  _trustedProjectsPathOverride = p;
}

function trustedProjectsFilePath(): string {
  return _trustedProjectsPathOverride ?? join(homedir(), ".zone", "trusted-projects.json");
}

/** Resolve to a canonical absolute path. Falls back to path.resolve for non-existent paths. */
export function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function loadTrustedProjects(): TrustedProjectsFile {
  const p = trustedProjectsFilePath();
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as TrustedProjectsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
      return { version: 1, projects: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { version: 1, projects: [] };
  }
}

function saveTrustedProjects(store: TrustedProjectsFile): void {
  const p = trustedProjectsFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch { /* Windows/non-POSIX — best effort */ }
}

/**
 * Returns true if candidatePath equals a trusted root or is a descendant of one.
 * Uses a path-separator boundary to prevent /home/user/foo2 matching /home/user/foo.
 * Entries that now classify as system/home_root are ignored (guards hand-edited JSON).
 */
export function isProjectTrusted(candidatePath: string): boolean {
  const candidate = canonicalizePath(candidatePath);
  const store = loadTrustedProjects();
  return store.projects.some(
    (entry) =>
      classifyPath(entry.path) === "normal" &&
      (candidate === entry.path || candidate.startsWith(entry.path + sep))
  );
}

/** Persist trust for a project root. Idempotent — skips if already trusted.
 *  Refuses to store system or home_root paths (defense-in-depth against misuse). */
export function addTrustedProject(root: string, trustedBy: "user" | "flag" | "env"): void {
  const canonicalRoot = canonicalizePath(root);
  if (classifyPath(canonicalRoot) !== "normal") return; // silently refuse system/home_root
  const store = loadTrustedProjects();
  if (store.projects.some((e) => e.path === canonicalRoot)) return;
  store.projects.push({ path: canonicalRoot, trustedAt: new Date().toISOString(), trustedBy });
  saveTrustedProjects(store);
}

/**
 * Walk up the directory tree looking for a .git entry (no git execution).
 * Falls back to canonicalize(startPath) if no .git is found.
 */
export function resolveProjectRoot(startPath: string): string {
  const canonical = canonicalizePath(startPath);
  let dir = canonical;
  for (;;) {
    try {
      statSync(join(dir, ".git"));
      return dir;
    } catch { /* not found at this level */ }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root reached
    dir = parent;
  }
  return canonical;
}
