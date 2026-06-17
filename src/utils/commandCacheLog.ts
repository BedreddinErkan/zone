import fs from "node:fs";
import path from "node:path";
import { ensureZoneGitignore } from "../core/ensureZoneGitignore.js";

const CACHE_MARKERS = new Set([
  "[zone-command-cache-hit]",
  "[zone-command-cache-miss]",
  "[zone-command-cache-summary]",
]);

const _createdDirs = new Set<string>();
// Serializes appends so log lines land in call order. Two un-awaited
// fs.promises.appendFile calls race on the libuv threadpool (O_APPEND keeps each
// line atomic but does not order the writes), which made line order
// non-deterministic under load. Chaining onto a single tail promise fixes it.
let _writeChain: Promise<void> = Promise.resolve();

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
 * Fire-and-forget — callers must not await the return value. Appends are
 * serialized in call order via _writeChain. Silently drops unknown markers.
 */
export function writeCacheLog(
  repoPath: string,
  marker: string,
  payload: Record<string, unknown>,
): void {
  if (!CACHE_MARKERS.has(marker)) return;

  const logsDir = path.join(repoPath, ".zone", "logs");
  ensureLogsDir(logsDir);
  void ensureZoneGitignore(repoPath);

  const filePath = path.join(logsDir, `command-cache-${todayDate()}.jsonl`);
  const line =
    JSON.stringify({ timestamp: new Date().toISOString(), marker, payload }) +
    "\n";

  _writeChain = _writeChain
    .then(() => fs.promises.appendFile(filePath, line))
    .catch(() => {}); // per-link: one failed write can't break the chain
}

/** Waits for all in-flight file writes. For test use only. */
export async function flushCommandCacheLogForTest(): Promise<void> {
  await _writeChain;
}

/** Resets module state. For test use only. */
export function clearCommandCacheLogForTest(): void {
  _createdDirs.clear();
  _writeChain = Promise.resolve();
}
