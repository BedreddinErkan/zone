import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const SYSTEM_ROOTS: ReadonlySet<string> = new Set([
  "/",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/var",
  "/opt",
  "/System",   // macOS
  "/Library",  // macOS
]);

export type PathClass = "system" | "home_root" | "normal";

function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Classify a path as "system", "home_root", or "normal".
 *
 * "system"    — exact match to a critical OS root (NOT descendants; /usr/local is "normal")
 * "home_root" — exact match to os.homedir() canonical (subdirs of home are "normal")
 * "normal"    — everything else (legit project locations)
 *
 * System roots are checked against both the lexically-resolved path (path.resolve — no symlink
 * following) AND the fully canonicalized path (realpathSync), so that /bin → "system" even on
 * systems where /bin is a symlink to /usr/bin.
 */
export function classifyPath(p: string): PathClass {
  const lexical   = resolve(p);          // normalize without following symlinks
  const canonical = canonicalize(p);     // follows symlinks
  if (SYSTEM_ROOTS.has(lexical) || SYSTEM_ROOTS.has(canonical)) return "system";
  if (canonical === canonicalize(homedir())) return "home_root";
  return "normal";
}
