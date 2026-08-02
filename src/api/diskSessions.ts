import { promises as fs } from "node:fs";
import nodeFs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { TranscriptEntry } from "../cli/tui/store.js";
import { log } from "../utils/logger.js";

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

/**
 * Synchronous sibling of saveSession, for the signal path ONLY.
 *
 * Why sync exists: Ink installs signal-exit (ink.js:238), whose listener force-kills the
 * process when `process.listeners(sig).length === emitter.count` (signal-exit/index.js:121)
 * — a comparison against a count of foreign subscribers we do not control, one of which
 * (restore-cursor) subscribes lazily when the cursor is hidden. When that guard matches,
 * `process.kill(pid, sig)` fires and any in-flight async write dies with the process. Four
 * consecutive dogfood runs lost their session that way; SIGINT survived only when the count
 * happened not to match. Durability at process death cannot depend on that.
 *
 * CORRECTION (2026-08-01): the paragraph above states the guard correctly but is incomplete
 * read alone. Once ANY handler is registered for a signal — including the one in
 * registerFatalSignalHandlers (src/cli/tui/index.tsx) that this function backs — the guard
 * can never match again: emitter.count does not count subscribers, it counts loaded
 * signal-exit module instances (load(), signal-exit/index.js:154, behind the module-local
 * `loaded` guard at :145-147), and load() also installs exactly one process listener per
 * signal (:158). Every instance adds one listener AND one count together, so
 * listeners.length === emitter.count only holds at zero foreign listeners — a state that
 * handler's own presence rules out, independent of restore-cursor or any other subscriber.
 * This function is therefore real insurance against async-loss modes in general; it has NOT
 * been shown necessary against signal-exit specifically, and by this proof cannot be. One
 * data point stays unexplained under it: a direct kill -HUP after that handler existed
 * (async write, pre-sync-write) produced no session file, which this proof says should have
 * stood down and saved instead. Recorded rather than resolved.
 *
 * `import nodeFs from "node:fs"` deliberately, not named imports: the test-home guard
 * intercepts the fs write surface by property assignment, and a named import snapshots the
 * binding and makes the guard silently inert (src/test/homeWriterImportStyle.test.ts fails
 * the suite when that happens).
 *
 * The normal exit path keeps the async saveSession — it awaits waitUntilExit() with nothing
 * terminating underneath it, so blocking the event loop there would buy nothing.
 */
export function saveSessionSync(_cwd: string, session: DiskSession): string {
  const dir = sessionsDir();
  nodeFs.mkdirSync(dir, { recursive: true });
  const filename = makeFilename(session.sessionId);
  const p = sessionFilePath(filename);
  const tmp = `${p}.tmp`;
  // writeFile + rename is the whole of durability here; mkdir is idempotent and chmod is
  // cosmetic, so only these two must complete before the handler returns.
  nodeFs.writeFileSync(tmp, JSON.stringify(session, null, 2), "utf-8");
  nodeFs.renameSync(tmp, p);
  try { nodeFs.chmodSync(p, 0o600); } catch { /* best effort */ }
  return filename;
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

/** Every session filename, newest first, regardless of which repo saved it. Unscoped
 *  deliberately: pruneOldSessions uses this directly so its cap stays global across repos
 *  even though listSessions (below) is repo-scoped — see diskSessions.test.ts's
 *  "repo scoping" describe block for what would break if the two were merged. */
async function listAllSessionFilenames(): Promise<string[]> {
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

export async function listSessions(cwd: string): Promise<string[]> {
  const filenames = await listAllSessionFilenames();
  const result: string[] = [];
  for (const filename of filenames) {
    let session: DiskSession | null;
    try {
      session = await loadSession(cwd, filename);
    } catch (err) {
      // loadSession already separates ENOENT (benign — file pruned between readdir and read,
      // returns null, never reaches here) from everything else (re-thrown). Anything caught
      // here is a real fault by loadSession's own distinction, not a race.
      log("[zone-session-load-failed]", JSON.stringify({
        filename,
        queryingCwd: cwd,
        reason: err instanceof Error ? err.message : String(err),
      }));
      continue;
    }
    if (session && session.cwd === cwd) result.push(filename);
  }
  return result;
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

export async function pruneOldSessions(_cwd: string, keep: number = MAX_SESSIONS): Promise<number> {
  // Deliberately unscoped — see listAllSessionFilenames's own comment. The cap bounds total
  // disk usage across every repo, not per repo; _cwd stays in the signature only so callers
  // (and their existing call sites) don't need to change shape.
  const list = await listAllSessionFilenames();
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
