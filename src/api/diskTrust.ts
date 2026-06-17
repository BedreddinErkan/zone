import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { ensureZoneGitignore } from "../core/ensureZoneGitignore.js";

export interface DiskTrustEntry {
  prefix: string;
  addedAt: string;
  addedBy: "user" | "system";
}

export interface DiskTrustFile {
  version: 1;
  trustedPrefixes: DiskTrustEntry[];
}

const TRUST_FILENAME = ".zone/trust.json";

export async function loadDiskTrust(cwd: string): Promise<DiskTrustFile> {
  try {
    const raw = await fs.readFile(join(cwd, TRUST_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as DiskTrustFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.trustedPrefixes)) {
      return { version: 1, trustedPrefixes: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, trustedPrefixes: [] };
    throw err;
  }
}

async function saveDiskTrust(cwd: string, store: DiskTrustFile): Promise<void> {
  const path = join(cwd, TRUST_FILENAME);
  await fs.mkdir(dirname(path), { recursive: true });
  await ensureZoneGitignore(cwd);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tmp, path);
}

export async function addDiskTrustPrefix(
  cwd: string,
  prefix: string,
  addedBy: "user" | "system" = "user",
): Promise<void> {
  const store = await loadDiskTrust(cwd);
  if (store.trustedPrefixes.some(e => e.prefix === prefix)) return;
  store.trustedPrefixes.push({ prefix, addedAt: new Date().toISOString(), addedBy });
  await saveDiskTrust(cwd, store);
}

export async function removeDiskTrustPrefix(cwd: string, prefix: string): Promise<void> {
  const store = await loadDiskTrust(cwd);
  store.trustedPrefixes = store.trustedPrefixes.filter(e => e.prefix !== prefix);
  await saveDiskTrust(cwd, store);
}

export function diskTrustPrefixes(store: DiskTrustFile): string[] {
  return store.trustedPrefixes.map(e => e.prefix);
}
