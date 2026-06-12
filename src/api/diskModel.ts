import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

// keep in sync with modelRegistry.ts:EffortLevel
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface DiskModelSettings {
  version: 2;
  model: string;
  provider: "anthropic" | "openai";
  effort?: EffortLevel;
  summaryFormat?: "compact" | "detailed";
  memoryEnabled?: boolean;
  commitOnSuccess?: boolean;
  webSearchEnabled?: boolean;
  planDepth?: "quick" | "investigate" | "strict";
  updatedAt: string;
}

function modelPath(cwd: string): string {
  return path.join(cwd, ".zone", "model.json");
}

export async function loadDiskModel(cwd: string): Promise<DiskModelSettings | null> {
  const p = modelPath(cwd);
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (parsed.version !== 2) {
      console.warn(`[zone] .zone/model.json has unexpected version (${parsed.version}); ignoring.`);
      return null;
    }
    return parsed as DiskModelSettings;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export function loadDiskModelSync(cwd: string): DiskModelSettings | null {
  const p = modelPath(cwd);
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as { version?: unknown };
    if (parsed.version !== 2) return null;
    return parsed as DiskModelSettings;
  } catch {
    return null;
  }
}

export async function saveDiskModel(cwd: string, s: DiskModelSettings): Promise<void> {
  const p = modelPath(cwd);
  const tmp = `${p}.tmp`;
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf-8");
  await fs.rename(tmp, p);
  try { await fs.chmod(p, 0o600); } catch { /* Windows/non-POSIX — best effort */ }
}
