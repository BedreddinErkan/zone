import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";

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

const KEYS_FILENAME = ".zone/keys.json";

export async function loadDiskKeys(cwd: string): Promise<DiskKeysFile> {
  try {
    const raw = await fs.readFile(join(cwd, KEYS_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as DiskKeysFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) {
      return { version: 1, keys: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: [] };
    throw err;
  }
}

async function saveDiskKeys(cwd: string, store: DiskKeysFile): Promise<void> {
  const p = join(cwd, KEYS_FILENAME);
  await fs.mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tmp, p);
  try { await fs.chmod(p, 0o600); } catch { /* Windows/non-POSIX — best effort */ }
}

export async function setDiskKey(cwd: string, provider: ApiKeyProvider, key: string): Promise<void> {
  const store = await loadDiskKeys(cwd);
  const idx = store.keys.findIndex(k => k.provider === provider);
  const entry: DiskApiKey = { provider, key, addedAt: new Date().toISOString() };
  if (idx >= 0) store.keys[idx] = entry;
  else store.keys.push(entry);
  await saveDiskKeys(cwd, store);
}

export async function removeDiskKey(cwd: string, provider: ApiKeyProvider): Promise<void> {
  const store = await loadDiskKeys(cwd);
  store.keys = store.keys.filter(k => k.provider !== provider);
  await saveDiskKeys(cwd, store);
}

export function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 7)}***${key.slice(-4)}`;
}
