import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RepoEntry {
  id: string;
  label: string;
  path: string;
  isDefault?: boolean;
}

function getConfigPath(): string {
  const dir = process.env.ZONE_CONFIG_DIR || path.join(os.homedir(), ".zone");
  return path.join(dir, "repos.json");
}

export function loadRepoRegistry(): RepoEntry[] {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [
    {
      id: "default:zone-api",
      label: "zone-api",
      path: path.resolve(process.cwd()),
      isDefault: true,
    },
  ];
}

export function saveRepoRegistry(repos: RepoEntry[]): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(repos, null, 2), "utf8");
}

export async function addRepo(
  label: string,
  repoPath: string
): Promise<{ ok: boolean; error?: string; repo?: RepoEntry }> {
  try {
    await fs.promises.stat(repoPath);
  } catch {
    return { ok: false, error: `Path does not exist: ${repoPath}` };
  }
  try {
    await fs.promises.stat(path.join(repoPath, ".git"));
  } catch {
    return { ok: false, error: `Not a git repository: ${repoPath}` };
  }
  const repos = loadRepoRegistry();
  const existing = repos.find((r) => r.path === repoPath);
  if (existing) return { ok: true, repo: existing };
  const repo: RepoEntry = {
    id: crypto.randomUUID(),
    label: label || path.basename(repoPath),
    path: repoPath,
  };
  repos.push(repo);
  saveRepoRegistry(repos);
  return { ok: true, repo };
}

export function removeRepo(id: string): { ok: boolean; error?: string } {
  const repos = loadRepoRegistry();
  const entry = repos.find((r) => r.id === id);
  if (!entry) return { ok: false, error: "Not found" };
  if (entry.isDefault) return { ok: false, error: "Cannot remove default entries" };
  const updated = repos.filter((r) => r.id !== id);
  if (!updated.length) return { ok: false, error: "Cannot remove the last repo" };
  saveRepoRegistry(updated);
  return { ok: true };
}
