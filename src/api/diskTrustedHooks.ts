// Namespace import, not named bindings: the test-suite home guard
// (src/test/setup/homeGuard.ts) intercepts writes by assigning over the fs
// module's properties, and a named function import snapshots the binding at
// evaluation and never sees that assignment.
import fs from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { canonicalizePath } from "./diskTrustedProjects.js";

interface TrustedHooksEntry {
  projectPath: string;
  hash: string;
  approvedAt: string;
}

interface TrustedHooksFile {
  version: 1;
  entries: TrustedHooksEntry[];
}

let _trustedHooksPathOverride: string | null = null;

export function _setTrustedHooksPathForTest(p: string | null): void {
  _trustedHooksPathOverride = p;
}

function trustedHooksFilePath(): string {
  return _trustedHooksPathOverride ?? join(homedir(), ".zone", "trusted-hooks.json");
}

function loadTrustedHooks(): TrustedHooksFile {
  const p = trustedHooksFilePath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as TrustedHooksFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { version: 1, entries: [] };
  }
}

function saveTrustedHooks(store: TrustedHooksFile): void {
  const p = trustedHooksFilePath();
  fs.mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* Windows/non-POSIX — best effort */ }
}

export function isHooksTrusted(projectPath: string, hash: string): boolean {
  const canonical = canonicalizePath(projectPath);
  const store = loadTrustedHooks();
  return store.entries.some((e) => e.projectPath === canonical && e.hash === hash);
}

export function recordHooksTrust(projectPath: string, hash: string): void {
  const canonical = canonicalizePath(projectPath);
  const store = loadTrustedHooks();
  const existing = store.entries.find((e) => e.projectPath === canonical);
  if (existing) {
    existing.hash = hash;
    existing.approvedAt = new Date().toISOString();
  } else {
    store.entries.push({ projectPath: canonical, hash, approvedAt: new Date().toISOString() });
  }
  saveTrustedHooks(store);
}
