import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TranscriptEntry } from "../cli/tui/store.js";

export interface DiskSession {
  version: 1;
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  cwd: string;
  model: string;
  transcript: TranscriptEntry[];
  totalCostUsd: number;
  totalTokens: number;
  totalElapsedMs: number;
}

const SESSIONS_DIR = ".zone/sessions";
const MAX_SESSIONS = 30;

function sessionsDir(cwd: string): string {
  return join(cwd, SESSIONS_DIR);
}

function sessionFilePath(cwd: string, filename: string): string {
  return join(sessionsDir(cwd), filename);
}

function makeFilename(sessionId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}-${sessionId.slice(0, 8)}.json`;
}

export async function saveSession(cwd: string, session: DiskSession): Promise<string> {
  const dir = sessionsDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  const filename = makeFilename(session.sessionId);
  const path = sessionFilePath(cwd, filename);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session, null, 2), "utf-8");
  await fs.rename(tmp, path);
  try { await fs.chmod(path, 0o600); } catch { /* best effort */ }
  return filename;
}

export async function listSessions(cwd: string): Promise<string[]> {
  try {
    const files = await fs.readdir(sessionsDir(cwd));
    return files
      .filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
      .sort()
      .reverse();   // newest first — ISO prefix makes lexicographic = chronological
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function loadSession(cwd: string, filename: string): Promise<DiskSession | null> {
  try {
    const raw = await fs.readFile(sessionFilePath(cwd, filename), "utf-8");
    const parsed = JSON.parse(raw) as DiskSession;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadLastSession(cwd: string): Promise<DiskSession | null> {
  const list = await listSessions(cwd);
  if (list.length === 0) return null;
  return loadSession(cwd, list[0]);
}

export async function pruneOldSessions(cwd: string, keep: number = MAX_SESSIONS): Promise<number> {
  const list = await listSessions(cwd);
  if (list.length <= keep) return 0;
  const toRemove = list.slice(keep);
  await Promise.all(toRemove.map(f =>
    fs.unlink(sessionFilePath(cwd, f)).catch(() => {})
  ));
  return toRemove.length;
}

export function newSessionId(): string {
  return randomUUID();
}
