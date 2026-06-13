import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
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
    const raw = readFileSync(p, "utf-8");
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
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch { /* Windows/non-POSIX — best effort */ }
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
