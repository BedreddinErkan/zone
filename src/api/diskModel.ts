import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ensureZoneGitignore } from "../core/ensureZoneGitignore.js";
import type { ApiKeyProvider } from "./diskKeys.js";

// keep in sync with modelRegistry.ts:EffortLevel
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface DiskModelSettings {
  version: 2;
  model: string;
  /**
   * The two built-ins, or a gateway profile id from the key store (step 5 of the gateway
   * recommendation). Widened WITHOUT a version bump, deliberately, and the older-binary behaviour
   * was measured before doing it rather than predicted:
   *
   *   - The loaders below do not reject it. Read from the emitted artifact, because types erase and
   *     only the JS runs — `dist/api/diskModel.js` contains ZERO occurrences of "provider". Both
   *     gate on `version !== 2` alone, then return the parsed object; the cast has no runtime effect.
   *   - Upstream degrades in TWO independent steps, not one. On an older binary the provider falls
   *     back to anthropic — SILENTLY on the published v2.1.0, whose `resolveProvider` is just
   *     `if (value === "openai") return "openai"; return "anthropic"` — and then the model falls back
   *     too, at `getModelName`, to that provider's standard-tier default. The end state is coherent
   *     (an Anthropic model on the Anthropic provider, no crash, no data loss) and v2.1.0 does emit
   *     the model warning, so the downgrade is visible even where the provider half is not.
   *
   * A version bump would be far worse: `loadDiskModelSync` returns null on a mismatch with no
   * warning at all, silently reverting model, effort, plan depth, autocommit and session memory to
   * defaults at once.
   */
  provider: ApiKeyProvider;
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
  await ensureZoneGitignore(cwd);
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf-8");
  await fs.rename(tmp, p);
  try { await fs.chmod(p, 0o600); } catch { /* Windows/non-POSIX — best effort */ }
}
