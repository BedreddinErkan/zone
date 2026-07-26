import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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

const MAX_SESSIONS = 30;

let _sessionsDirOverride: string | null = null;

/** For test isolation only — redirect where sessions are stored. */
export function _setSessionsDirForTest(p: string | null): void {
  _sessionsDirOverride = p;
}

function sessionsDir(): string {
  return _sessionsDirOverride ?? join(homedir(), ".zone", "sessions");
}

function sessionFilePath(filename: string): string {
  return join(sessionsDir(), filename);
}

function makeFilename(sessionId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}-${sessionId.slice(0, 8)}.json`;
}

export async function saveSession(_cwd: string, session: DiskSession): Promise<string> {
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  const filename = makeFilename(session.sessionId);
  const p = sessionFilePath(filename);
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session, null, 2), "utf-8");
  await fs.rename(tmp, p);
  try { await fs.chmod(p, 0o600); } catch { /* best effort */ }
  return filename;
}

/** Run envelopes share this directory but are a different artifact with a different
 *  schema and lifecycle (see diskRunEnvelope.ts). They must not appear here: this
 *  list drives --resume, the /sessions picker, AND pruneOldSessions, so including
 *  them means the pruner deletes durable run state it knows nothing about. They
 *  also break the sort's premise — `<sessionId>.envelope.json` has no ISO prefix,
 *  so it orders by a random UUID rather than by time. */
const ENVELOPE_SUFFIX = ".envelope.json";

export async function listSessions(_cwd: string): Promise<string[]> {
  try {
    const files = await fs.readdir(sessionsDir());
    return files
      .filter(f => f.endsWith(".json") && !f.endsWith(".tmp") && !f.endsWith(ENVELOPE_SUFFIX))
      .sort()
      .reverse();   // newest first — ISO prefix makes lexicographic = chronological
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function loadSession(_cwd: string, filename: string): Promise<DiskSession | null> {
  try {
    const raw = await fs.readFile(sessionFilePath(filename), "utf-8");
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
    fs.unlink(sessionFilePath(f)).catch(() => {})
  ));
  return toRemove.length;
}

export function newSessionId(): string {
  return randomUUID();
}

export interface SessionMeta {
  filename: string;
  sessionId: string;
  startedAt: string;
  model: string;
  totalCostUsd: number;
  firstUserMessage: string;
  messageCount: number;
}

export async function listSessionsMeta(cwd: string, limit = 50): Promise<SessionMeta[]> {
  const filenames = await listSessions(cwd);
  const results: SessionMeta[] = [];
  for (const filename of filenames.slice(0, limit)) {
    try {
      const session = await loadSession(cwd, filename);
      if (!session) continue;
      const userMessages = session.transcript.filter(
        (e): e is Extract<typeof e, { kind: "user_prompt" }> => e.kind === "user_prompt"
      );
      results.push({
        filename,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        model: session.model,
        totalCostUsd: session.totalCostUsd,
        firstUserMessage: userMessages[0]?.text ?? "",
        messageCount: userMessages.length,
      });
    } catch {
      // skip corrupt or unreadable files
    }
  }
  return results;
}
