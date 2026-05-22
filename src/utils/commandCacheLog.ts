import fs from "node:fs";
import path from "node:path";

const CACHE_MARKERS = new Set([
  "[zone-command-cache-hit]",
  "[zone-command-cache-miss]",
  "[zone-command-cache-summary]",
]);

const _createdDirs = new Set<string>();
const _pendingWrites = new Set<Promise<void>>();

function ensureLogsDir(logsDir: string): void {
  if (!_createdDirs.has(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    _createdDirs.add(logsDir);
  }
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Append one JSONL line for the given cache marker to
 * {repoPath}/.zone/logs/command-cache-{YYYY-MM-DD}.jsonl.
 * Fire-and-forget — callers must not await the return value.
 * Silently drops writes for unknown markers.
 */
export function writeCacheLog(
  repoPath: string,
  marker: string,
  payload: Record<string, unknown>,
): void {
  if (!CACHE_MARKERS.has(marker)) return;

  const logsDir = path.join(repoPath, ".zone", "logs");
  ensureLogsDir(logsDir);

  const filePath = path.join(logsDir, `command-cache-${todayDate()}.jsonl`);
  const line =
    JSON.stringify({ timestamp: new Date().toISOString(), marker, payload }) +
    "\n";

  let p!: Promise<void>;
  p = fs.promises
    .appendFile(filePath, line)
    .catch(() => {})
    .finally(() => {
      _pendingWrites.delete(p);
    });
  _pendingWrites.add(p);
}

/** Waits for all in-flight file writes. For test use only. */
export async function flushCommandCacheLogForTest(): Promise<void> {
  await Promise.allSettled([..._pendingWrites]);
}

/** Resets module state. For test use only. */
export function clearCommandCacheLogForTest(): void {
  _createdDirs.clear();
}
