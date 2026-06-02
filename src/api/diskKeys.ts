import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type ApiKeyProvider = "anthropic" | "openai";

export interface DiskApiKey {
  provider: ApiKeyProvider;
  key: string;
  addedAt: string;
}

export interface DiskKeysFile {
  version: 1;
  keys: DiskApiKey[];
}

let _keysFilePathOverride: string | null = null;
let _legacyKeysPathOverride: string | null = null;

/** For test isolation only — redirect where keys are stored. */
export function _setKeysFilePathForTest(homePath: string | null, legacyPath: string | null = null): void {
  _keysFilePathOverride = homePath;
  _legacyKeysPathOverride = legacyPath;
}

function keysFilePath(): string {
  return _keysFilePathOverride ?? join(homedir(), ".zone", "keys.json");
}

export async function loadDiskKeys(): Promise<DiskKeysFile> {
  const p = keysFilePath();
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as DiskKeysFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) {
      return { version: 1, keys: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Migration: move legacy cwd-relative keys to home dir (do not delete old file)
    const legacy = _legacyKeysPathOverride ?? join(process.cwd(), ".zone", "keys.json");
    try {
      const raw = await fs.readFile(legacy, "utf-8");
      const parsed = JSON.parse(raw) as DiskKeysFile;
      if (parsed.version === 1 && Array.isArray(parsed.keys)) {
        await saveDiskKeys(parsed);
        console.log("[zone-keys-migrated] moved .zone/keys.json → ~/.zone/keys.json");
        return parsed;
      }
    } catch { /* not present or corrupt — skip */ }
    return { version: 1, keys: [] };
  }
}

async function saveDiskKeys(store: DiskKeysFile): Promise<void> {
  const p = keysFilePath();
  await fs.mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tmp, p);
  try { await fs.chmod(p, 0o600); } catch { /* Windows/non-POSIX — best effort */ }
}

export async function setDiskKey(provider: ApiKeyProvider, key: string): Promise<void> {
  if (key.startsWith("<")) {
    throw new Error(`${provider} API key looks like a placeholder ("<…>") — set a real key.`);
  }
  for (let i = 0; i < key.length; i++) {
    const cp = key.charCodeAt(i);
    if (cp < 0x20 || cp > 0x7e) {
      throw new Error(
        `${provider} API key contains a non-ASCII character at byte ${i} ` +
        `(U+${cp.toString(16).toUpperCase().padStart(4, "0")}) — likely a placeholder, not a real key.`
      );
    }
  }
  const store = await loadDiskKeys();
  const idx = store.keys.findIndex(k => k.provider === provider);
  const entry: DiskApiKey = { provider, key, addedAt: new Date().toISOString() };
  if (idx >= 0) store.keys[idx] = entry;
  else store.keys.push(entry);
  await saveDiskKeys(store);
}

export async function removeDiskKey(provider: ApiKeyProvider): Promise<void> {
  const store = await loadDiskKeys();
  store.keys = store.keys.filter(k => k.provider !== provider);
  await saveDiskKeys(store);
}

export function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 7)}***${key.slice(-4)}`;
}
