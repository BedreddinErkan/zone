import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../utils/logger.js";
import type { ExecutionPlan } from "../llm/executionPlan.js";
import type { RunTodo } from "../core/todoLifecycle.js";
// type-only import — erased at compile time; no runtime cycle with agentLoop.ts
import type { AgentLoopResult } from "../llm/agentLoop.js";

// ---- Schema ----------------------------------------------------------------

export interface StagedEntryEnvelope {
  /** Repo-relative path (display + reconciliation key). */
  path: string;
  /** Absolute path as staged — re-seeds the staging map directly. */
  absPath: string;
  /** sha256 of the file's content when it first entered staging (the base). "" for new files. */
  baseHash: string;
  /** Did the file exist on disk when first staged? false ⇒ new-file create. */
  baseExisted: boolean;
  /** Full staged content (staging map is full-content, not diffs). */
  content: string;
}

/**
 * Derived from AgentLoopResult.terminationReason — adding a new terminationReason
 * to AgentLoopResult automatically makes it resumable (zero envelope change).
 */
export type EnvelopeStatus =
  | "running"
  | Exclude<NonNullable<AgentLoopResult["terminationReason"]>, "natural_completion">
  | "unknown";

export interface FailureRecordLite {
  trigger: string;
  errorLine: number | null;
  patchHash: string;
  iter: number;
}

export interface RunEnvelope {
  version: 1;
  sessionId: string;
  /**
   * The run that created this envelope, and its filename key.
   *
   * Envelopes used to be keyed by sessionId alone, but the TUI mints one
   * sessionId per process, so every run in a session wrote the same file and a
   * second run's first checkpoint destroyed a suspended one. Keying per run makes
   * two runs structurally unable to target one path.
   *
   * Optional because envelopes written before that cutover do not have it; those
   * are keyed by sessionId and stay that way. A resumed run PRESERVES this field
   * rather than substituting its own id, so a resume continues its source
   * envelope instead of forking a second one — which also keeps it pointing at
   * the run that actually asked any outstanding question.
   */
  runId?: string;
  /** process.pid of the zone run — used for hard-kill liveness detection. */
  pid: number;
  repoPath: string;
  model: string;
  /** Original user task — needed to continue the run on resume. */
  task: string;
  createdAt: string;
  updatedAt: string;
  /**
   * "running" while live; stamped to terminationReason at graceful exit.
   * A "running" envelope with a dead PID = hard-killed run (resumable).
   */
  status: EnvelopeStatus;
  executionPlan: ExecutionPlan | null;
  todos: RunTodo[];
  /** Last ~8 failure records per path. */
  failureHistory: Array<{ path: string; records: FailureRecordLite[] }>;
  /** Staged content (full file content per path; entries >1MB are omitted). */
  staging: StagedEntryEnvelope[];
  /** Paths already flushed to disk by persistStagingOnError — suppress drop-notes for these (R2). */
  flushedPaths: string[];
  /**
   * Repo-relative paths created direct-to-disk this run via write_file's new-file
   * path (toolExecutor.ts:2671) — which bypasses stagingFiles, so these never appear
   * in `staging`. On a hard kill these files survive ON DISK; this list is the
   * completion signal so resume does not re-create them. Optional: envelopes written
   * before S10 lack it (treat as []).
   */
  createdPaths?: string[];
  /** Carried verbatim from the run — NOT a replacement for the FS-event summary path. */
  priorSessionSummary: string;
  /** Pruned message history (what was last sent to the LLM). Absent when over cap or prior to first checkpoint. */
  messages?: unknown[];
  /**
   * True when `messages` was dropped for exceeding the size cap, as opposed to
   * never having been written. Without this the two are indistinguishable on
   * read, and a resume would quietly cold-start a conversation the user believes
   * is being continued — the failure the loud-marker rule exists to prevent.
   */
  messagesOmitted?: boolean;
  /**
   * True when `messages` is present but its thinking passthrough was stripped to
   * fit the size cap. Deliberately NOT folded into `messagesOmitted`: "resumed
   * without reasoning" costs one turn of re-derivation, "resumed without a
   * conversation" costs a cold start, and a single flag would make the two
   * indistinguishable in exactly the telemetry that has to tell them apart.
   */
  thinkingOmitted?: boolean;
  /**
   * Set when the run stopped with a question outstanding (status
   * "awaiting_user_input"). Carries the tool_call_id because the restored
   * conversation ends with an assistant tool_call that has no reply, and the
   * Chat Completions protocol requires one before the next call.
   *
   * questionId is deliberately absent: it indexes an in-memory registry that
   * does not survive the process, so persisting it would look resolvable when
   * it is not.
   */
  /**
   * The user set this suspended run aside (Esc at a carried-over question).
   *
   * A marker rather than a delete, because a parked envelope can be the ONLY
   * copy of staged work: flushRunCheckpoint writes before the wait, while
   * persistStagingOnError runs only on the graceful-abort branch, so a hard kill
   * during the wait leaves successful apply_patch results nowhere else. One
   * unconfirmed keystroke must not destroy that while the user's mental model is
   * "start fresh". Dismissed envelopes stop being offered; they stay reachable
   * with `--resume <key>`.
   */
  dismissedAt?: string;
  pendingQuestion?: {
    toolCallId: string;
    question: string;
    /** Iteration the ask happened on — carried so a dismissal at the turn
     *  boundary reports the same shape as the in-run decline instead of
     *  inventing a value for a field it cannot otherwise know. */
    iter: number;
  };
}

export interface ReconcileResult {
  restored: Map<string, string>; // absPath → staged content
  dropNotes: string[];
}

// ---- File path helpers -----------------------------------------------------

let _envelopeDirOverride: string | null = null;

/** For test isolation only. */
export function _setEnvelopeDirForTest(p: string | null): void {
  _envelopeDirOverride = p;
}

function envelopesDir(): string {
  return _envelopeDirOverride ?? join(homedir(), ".zone", "sessions");
}

/**
 * The envelope directory as it stands right now.
 *
 * Callers that enqueue writes for later — the checkpoint writer is the only one —
 * must resolve this ONCE up front and pass it back as `saveRunEnvelope`'s `dir`.
 * Resolving inside the write means a queued write lands wherever the directory
 * happens to point when it finally runs, which is how the park-durability tests
 * leaked envelopes into the real ~/.zone after restoring the override.
 */
export function currentEnvelopesDir(): string {
  return envelopesDir();
}

function envelopeFilePath(key: string, dir?: string): string {
  return join(dir ?? envelopesDir(), `${key}.envelope.json`);
}

const ENVELOPE_SUFFIX = ".envelope.json";

/**
 * The filename key for an envelope: its runId, or its sessionId when it predates
 * per-run keying. The only place that encodes the two-shape layout — everywhere
 * else takes a key it was handed, so no caller has to know which shape it holds.
 */
export function envelopeKeyFor(env: RunEnvelope): string {
  return env.runId ?? env.sessionId;
}

/** An envelope plus the key it was actually read from — never inferred. */
export type ResumableEnvelope = RunEnvelope & { key: string };

// ---- PID liveness ----------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isResumable(env: RunEnvelope): boolean {
  // Stamped non-natural exits are resumable; "running" + dead pid = hard-killed.
  return env.status !== "running" || !isPidAlive(env.pid);
}

// ---- CRUD ------------------------------------------------------------------

/**
 * @param opts.dir Write here instead of resolving the directory now. Supplied by
 *   callers that enqueue writes — see currentEnvelopesDir.
 *
 * Failures are logged and rethrown. The rethrow matters as much as the log: every
 * caller that swallows this (createCoalescingWriter's catch, forceFlush's
 * .catch) was previously the ONLY handler, so a full disk or a permission error
 * lost the envelope in silence — and a parked envelope is sometimes the sole copy
 * of staged work that never reached the working tree.
 */
export async function saveRunEnvelope(
  env: RunEnvelope,
  opts?: { dir?: string },
): Promise<void> {
  const dir = opts?.dir ?? envelopesDir();
  const p = envelopeFilePath(envelopeKeyFor(env), dir);
  const tmp = `${p}.tmp`;
  const stamped: RunEnvelope = { ...env, updatedAt: new Date().toISOString() };
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(stamped, null, 2), "utf-8");
    await fs.rename(tmp, p);
  } catch (err) {
    log("[zone-envelope-write-failed]", JSON.stringify({
      event: "envelope_write_failed",
      path: p,
      error: err instanceof Error ? err.message : String(err),
    }));
    throw err;
  }
  try { await fs.chmod(p, 0o600); } catch { /* best effort */ }
}

/** @param key an envelope key — a runId, or a sessionId for a pre-cutover file. */
export async function loadRunEnvelope(key: string): Promise<RunEnvelope | null> {
  try {
    const raw = await fs.readFile(envelopeFilePath(key), "utf-8");
    const parsed = JSON.parse(raw) as RunEnvelope;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function deleteRunEnvelope(key: string): Promise<void> {
  await fs.unlink(envelopeFilePath(key)).catch(() => {});
}

/** Reload-patch-save: update status and flushedPaths atomically. */
export async function stampEnvelopeStatus(
  key: string,
  status: string,
  flushedPaths: string[],
): Promise<void> {
  const env = await loadRunEnvelope(key);
  if (!env) return;
  await saveRunEnvelope({ ...env, status: status as EnvelopeStatus, flushedPaths });
}

// ---- Listing ---------------------------------------------------------------

/**
 * Every envelope carries the key it was read from, taken from its filename, so
 * callers resume by `.key` and never have to work out which of the two naming
 * shapes they are holding.
 */
export async function listResumableEnvelopes(repoPath?: string): Promise<ResumableEnvelope[]> {
  const dir = envelopesDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: ResumableEnvelope[] = [];
  for (const file of files) {
    if (!file.endsWith(ENVELOPE_SUFFIX) || file.endsWith(".tmp")) continue;
    try {
      const raw = await fs.readFile(join(dir, file), "utf-8");
      const env = JSON.parse(raw) as RunEnvelope;
      if (env.version !== 1) continue;
      if (repoPath !== undefined && env.repoPath !== repoPath) continue;
      if (!isResumable(env)) continue;
      results.push({ ...env, key: file.slice(0, -ENVELOPE_SUFFIX.length) });
    } catch {
      // skip corrupt files
    }
  }

  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results;
}

/**
 * The newest envelope worth OFFERING — dismissed ones are excluded, which is what
 * stops the startup toast and a bare `/resume` nagging about a run the user has
 * explicitly set aside. They remain in listResumableEnvelopes, and remain
 * reachable by key, because setting aside is not discarding.
 */
export async function latestResumableEnvelope(repoPath: string): Promise<ResumableEnvelope | null> {
  const list = await listResumableEnvelopes(repoPath);
  return list.find(e => !e.dismissedAt) ?? null;
}

/** Mark an envelope set-aside. Best-effort; a missing envelope is a no-op. */
export async function dismissEnvelope(key: string): Promise<void> {
  const env = await loadRunEnvelope(key);
  if (!env) return;
  await saveRunEnvelope({ ...env, dismissedAt: new Date().toISOString() });
}

export interface EnvelopeCleanupPolicy {
  maxAgeDays: number;
  maxCount: number;
}

const DEFAULT_ENVELOPE_CLEANUP_POLICY: EnvelopeCleanupPolicy = {
  maxAgeDays: 30,
  maxCount: 200,
};

/**
 * Prunes stale envelopes by age and count. Pruning is independent of
 * EnvelopeStatus (including "awaiting_user_input" — /resume relies on
 * age/count churn like everything else), EXCEPT a live status:"running"
 * envelope with an alive pid, which is never pruned — that's a hard
 * safety guard against deleting an in-flight run's state, not a status
 * grace period.
 */
export async function pruneOldEnvelopes(
  policy: Partial<EnvelopeCleanupPolicy> = {}
): Promise<{ removed: number }> {
  const { maxAgeDays, maxCount } = { ...DEFAULT_ENVELOPE_CLEANUP_POLICY, ...policy };
  const dir = envelopesDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0 };
    throw err;
  }

  const envelopeFiles = files.filter(f => f.endsWith(".envelope.json") && !f.endsWith(".tmp"));
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  type Candidate = { file: string; updatedAt: string; keep: boolean };
  const candidates: Candidate[] = [];

  for (const file of envelopeFiles) {
    try {
      const raw = await fs.readFile(join(dir, file), "utf-8");
      const env = JSON.parse(raw) as RunEnvelope;
      if (env.version !== 1) continue;
      // Safety guard: a live "running" envelope with an alive pid is never pruned.
      const isLiveRun = env.status === "running" && isPidAlive(env.pid);
      candidates.push({ file, updatedAt: env.updatedAt, keep: isLiveRun });
    } catch {
      // skip corrupt/unreadable files — leave them alone rather than risk mis-deleting
    }
  }

  const toRemove = new Set<string>();

  // Age cutoff: anything older than maxAgeDays (unless protected).
  for (const c of candidates) {
    if (c.keep) continue;
    const age = now - new Date(c.updatedAt).getTime();
    if (age > maxAgeMs) toRemove.add(c.file);
  }

  // Count cutoff: beyond maxCount survivors, remove oldest-first (protected entries excluded).
  const survivors = candidates.filter(c => !toRemove.has(c.file));
  if (survivors.length > maxCount) {
    const prunable = survivors
      .filter(c => !c.keep)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const excess = survivors.length - maxCount;
    for (let i = 0; i < Math.min(excess, prunable.length); i++) {
      toRemove.add(prunable[i].file);
    }
  }

  await Promise.all(
    Array.from(toRemove).map(f => fs.unlink(join(dir, f)).catch(() => {}))
  );

  return { removed: toRemove.size };
}

const ENVELOPE_CLEANUP_MARKER_NAME = ".envelope-last-cleanup";
const ENVELOPE_CLEANUP_THROTTLE_HOURS = 24;

/**
 * Runs pruneOldEnvelopes at most once per ENVELOPE_CLEANUP_THROTTLE_HOURS,
 * tracked via the mtime of a marker file on disk — mirrors
 * maybeCleanupOldSnapshots in src/snapshots/snapshotStore.ts verbatim, so a
 * per-run readdir/stat sweep doesn't happen on every invocation. The marker
 * filename does not end in ".envelope.json", so listResumableEnvelopes and
 * resolveEnvelopeId never enumerate it as a run.
 */
export async function maybeCleanupOldEnvelopes(
  policy: Partial<EnvelopeCleanupPolicy> = {}
): Promise<{ removed: number; ran: boolean }> {
  const dir = envelopesDir();
  const markerPath = join(dir, ENVELOPE_CLEANUP_MARKER_NAME);
  const thresholdMs = ENVELOPE_CLEANUP_THROTTLE_HOURS * 60 * 60 * 1000;

  try {
    const stat = await fs.stat(markerPath);
    if (Date.now() - stat.mtimeMs < thresholdMs) {
      return { removed: 0, ran: false };
    }
  } catch {
    /* marker missing: fall through and run */
  }

  const result = await pruneOldEnvelopes(policy);

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(markerPath, String(Date.now()), "utf8");
  } catch {
    /* swallow: throttle marker is best-effort */
  }

  return { ...result, ran: true };
}

/**
 * Resolve an id or prefix to an envelope key.
 *
 * Filenames are matched first — that is the key, and for post-cutover envelopes
 * it is a runId. The content scan afterwards is the migration guarantee: before
 * per-run keying the filename WAS the sessionId, so a sessionId a user already
 * knows (from a toast, a log line, an older note) would silently stop resolving.
 * It reads envelope bodies, which is free at a handful of files and gets linearly
 * worse as they accumulate — recorded next to the growth bound in lessons.md,
 * because the two facts only mean something together.
 */
export async function resolveEnvelopeId(idOrPrefix: string): Promise<string | null> {
  const dir = envelopesDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  // Exact filename match
  if (files.includes(`${idOrPrefix}${ENVELOPE_SUFFIX}`)) return idOrPrefix;

  const envelopeFiles = files.filter(f => f.endsWith(ENVELOPE_SUFFIX) && !f.endsWith(".tmp"));

  // Filename prefix match
  for (const file of envelopeFiles) {
    const key = file.slice(0, -ENVELOPE_SUFFIX.length);
    if (key.startsWith(idOrPrefix)) return key;
  }

  // Fallback: the id may be a sessionId of an envelope now keyed by runId.
  for (const file of envelopeFiles) {
    try {
      const env = JSON.parse(await fs.readFile(join(dir, file), "utf-8")) as RunEnvelope;
      if (env.version !== 1) continue;
      if (typeof env.sessionId === "string" && env.sessionId.startsWith(idOrPrefix)) {
        return file.slice(0, -ENVELOPE_SUFFIX.length);
      }
    } catch {
      // skip corrupt files
    }
  }
  return null;
}

// ---- Reconciliation --------------------------------------------------------

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Per-file reconciliation: compare disk state against the envelope's base hashes.
 * Returns files safe to restore and human-readable notes for dropped entries.
 */
export function reconcileEnvelopeStaging(env: RunEnvelope): ReconcileResult {
  const restored = new Map<string, string>();
  const dropNotes: string[] = [];
  const flushedSet = new Set(env.flushedPaths);

  for (const entry of env.staging) {
    const existsNow = fsSync.existsSync(entry.absPath);

    if (entry.baseExisted !== existsNow) {
      // File existence flipped since the run was interrupted
      if (!flushedSet.has(entry.absPath)) {
        const change = existsNow ? "created" : "deleted";
        dropNotes.push(`${entry.path}: file was ${change} since run was interrupted`);
      }
      continue;
    }

    if (entry.baseExisted) {
      let currentContent: string;
      try {
        currentContent = fsSync.readFileSync(entry.absPath, "utf-8");
      } catch {
        dropNotes.push(`${entry.path}: could not read current file`);
        continue;
      }
      if (sha256hex(currentContent) === entry.baseHash) {
        // Disk matches the base — safe to restore staged content
        restored.set(entry.absPath, entry.content);
      } else {
        if (!flushedSet.has(entry.absPath)) {
          dropNotes.push(`${entry.path}: file changed since run was interrupted`);
        }
      }
    } else {
      // New file (didn't exist at staging time, still absent) — restore
      restored.set(entry.absPath, entry.content);
    }
  }

  return { restored, dropNotes };
}

/**
 * Derive the set of new files created direct-to-disk this run. `filesModified`
 * tracks every written path (new + edited); edits also live in `stagingFiles`,
 * while new-file creates do not (write_file writes them straight to disk —
 * toolExecutor.ts:2671). So a path in filesModified whose absolute form is NOT a
 * staging key is a new-file create. Returns repo-relative paths, matching the
 * `staging[].path` convention.
 */
export function deriveCreatedPaths(
  filesModified: Iterable<string>,
  stagingFiles: Map<string, string>,
  repoPath: string,
): string[] {
  const created: string[] = [];
  for (const fm of filesModified) {
    const abs = resolve(repoPath, fm);
    if (!stagingFiles.has(abs)) {
      created.push(relative(repoPath, abs));
    }
  }
  return created;
}

// ---- Resume context block --------------------------------------------------

/** Builds the compact text injected into the first user message on resume. */
export function buildResumeContextBlock(env: RunEnvelope, dropNotes: string[]): string {
  const completedTodos = env.todos.filter(t => t.status === "completed");
  const nextTodo = env.todos.find(t => t.status === "in_progress" || t.status === "pending");
  const remaining = env.todos.filter(t => t.status === "pending" || t.status === "in_progress");
  const planTitle = env.executionPlan
    ? ((env.executionPlan as unknown as { title?: string }).title ?? "untitled plan")
    : "(no plan)";

  const recentFailures: string[] = [];
  for (const { path, records } of env.failureHistory.slice(0, 3)) {
    const latest = records[records.length - 1];
    if (latest) {
      recentFailures.push(
        `${path}: ${latest.trigger}${latest.errorLine != null ? ` (line ${latest.errorLine})` : ""}`,
      );
    }
  }

  const lines = [
    `RESUMED RUN — continuing an interrupted run (was: ${env.status}).`,
    `Plan: ${planTitle}`,
    completedTodos.length > 0
      ? `Completed steps: ${completedTodos.map(t => t.text).join("; ")}`
      : "Completed steps: (none)",
    nextTodo ? `Next step: ${nextTodo.text}` : "Next step: (all steps completed or not started)",
    remaining.length > 0 ? `Remaining: ${remaining.map(t => t.text).join("; ")}` : "",
    recentFailures.length > 0 ? `Recent failures: ${recentFailures.join("; ")}` : "",
    dropNotes.length > 0
      ? `Dropped staged changes (conflicts): ${dropNotes.join("; ")}`
      : "Staged changes: fully restored",
    (env.createdPaths?.length ?? 0) > 0
      ? `Already created on disk (do NOT recreate): ${env.createdPaths!.join("; ")}`
      : "",
    // Said plainly, because the alternative is the model answering as though it
    // remembers a conversation it cannot see.
    env.messagesOmitted
      ? "The earlier conversation from this run could NOT be restored — it exceeded the "
        + "size limit and was dropped. You have only the summary above. Do not refer to "
        + "earlier exchanges as though you can see them; re-establish anything you need."
      : "",
  ].filter(Boolean);

  return lines.join("\n");
}

// ---- Coalescing writer -----------------------------------------------------

export interface CoalescingWriter {
  /** Fire-and-forget: queues a write; collapses concurrent requests. */
  trigger(): void;
  /** Waits for any in-flight write, then forces one final write. */
  forceFlush(): Promise<void>;
  /**
   * Waits for queued work to finish WITHOUT forcing an extra write.
   *
   * Every `trigger()` is fire-and-forget, so without this a checkpoint can still
   * be in flight when the run exits and land AFTER stampEnvelopeStatus — leaving
   * the envelope stamped "running", which with a live PID isResumable reads as
   * "a run is in progress" and hides for the rest of the session.
   */
  drain(): Promise<void>;
}

/**
 * Creates a single-flight coalescing writer over an async save function.
 * - Only one write in flight at a time.
 * - If triggered while a write is in progress, sets a dirty flag and re-runs
 *   exactly once after the current write completes (converges to latest).
 * - Best-effort: saveFn errors are swallowed (never propagated to caller).
 */
export function createCoalescingWriter(saveFn: () => Promise<void>): CoalescingWriter {
  let inFlightPromise: Promise<void> | null = null;
  let dirty = false;

  async function run(): Promise<void> {
    dirty = false;
    try { await saveFn(); } catch { /* best effort */ }
    if (dirty) {
      inFlightPromise = run();
    } else {
      inFlightPromise = null;
    }
  }

  function trigger(): void {
    if (inFlightPromise !== null) {
      dirty = true;
    } else {
      inFlightPromise = run();
    }
  }

  async function forceFlush(): Promise<void> {
    if (inFlightPromise) {
      await inFlightPromise.catch(() => {});
    }
    // One final write regardless of dirty state
    await saveFn().catch(() => {});
    inFlightPromise = null;
    dirty = false;
  }

  async function drain(): Promise<void> {
    // Loop rather than a single await: run() re-assigns inFlightPromise to a
    // fresh run() when it finishes dirty, so awaiting once returns while the
    // follow-up write is still outstanding.
    while (inFlightPromise) {
      await inFlightPromise.catch(() => {});
    }
  }

  return { trigger, forceFlush, drain };
}
