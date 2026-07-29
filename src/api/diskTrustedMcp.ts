// Namespace import, not named bindings: the test-suite home guard
// (src/test/setup/homeGuard.ts) intercepts writes by assigning over the fs
// module's properties, and a named function import snapshots the binding at
// evaluation and never sees that assignment.
import fs from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { canonicalizePath } from "./diskTrustedProjects.js";

interface TrustedMcpEntry {
  projectPath: string;
  hash: string;
  approvedAt: string;
}

interface TrustedMcpFile {
  version: 1;
  entries: TrustedMcpEntry[];
}

let _trustedMcpPathOverride: string | null = null;

export function _setTrustedMcpPathForTest(p: string | null): void {
  _trustedMcpPathOverride = p;
}

function trustedMcpFilePath(): string {
  return _trustedMcpPathOverride ?? join(homedir(), ".zone", "trusted-mcp.json");
}

function loadTrustedMcp(): TrustedMcpFile {
  const p = trustedMcpFilePath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as TrustedMcpFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { version: 1, entries: [] };
  }
}

function saveTrustedMcp(store: TrustedMcpFile): void {
  const p = trustedMcpFilePath();
  fs.mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* Windows/non-POSIX — best effort */ }
}

export function isMcpTrusted(projectPath: string, hash: string): boolean {
  const canonical = canonicalizePath(projectPath);
  const store = loadTrustedMcp();
  return store.entries.some((e) => e.projectPath === canonical && e.hash === hash);
}

export function recordMcpTrust(projectPath: string, hash: string): void {
  const canonical = canonicalizePath(projectPath);
  const store = loadTrustedMcp();
  const existing = store.entries.find((e) => e.projectPath === canonical);
  if (existing) {
    existing.hash = hash;
    existing.approvedAt = new Date().toISOString();
  } else {
    store.entries.push({ projectPath: canonical, hash, approvedAt: new Date().toISOString() });
  }
  saveTrustedMcp(store);
}
