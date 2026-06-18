import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
  /** Carried verbatim from the run — NOT a replacement for the FS-event summary path. */
  priorSessionSummary: string;
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

function envelopeFilePath(sessionId: string): string {
  return join(envelopesDir(), `${sessionId}.envelope.json`);
}

// ---- PID liveness ----------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isResumable(env: RunEnvelope): boolean {
  // Stamped non-natural exits are resumable; "running" + dead pid = hard-killed.
  return env.status !== "running" || !isPidAlive(env.pid);
}

// ---- CRUD ------------------------------------------------------------------

export async function saveRunEnvelope(env: RunEnvelope): Promise<void> {
  const dir = envelopesDir();
  await fs.mkdir(dir, { recursive: true });
  const p = envelopeFilePath(env.sessionId);
  const tmp = `${p}.tmp`;
  const stamped: RunEnvelope = { ...env, updatedAt: new Date().toISOString() };
  await fs.writeFile(tmp, JSON.stringify(stamped, null, 2), "utf-8");
  await fs.rename(tmp, p);
  try { await fs.chmod(p, 0o600); } catch { /* best effort */ }
}

export async function loadRunEnvelope(sessionId: string): Promise<RunEnvelope | null> {
  try {
    const raw = await fs.readFile(envelopeFilePath(sessionId), "utf-8");
    const parsed = JSON.parse(raw) as RunEnvelope;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function deleteRunEnvelope(sessionId: string): Promise<void> {
  await fs.unlink(envelopeFilePath(sessionId)).catch(() => {});
}

/** Reload-patch-save: update status and flushedPaths atomically. */
export async function stampEnvelopeStatus(
  sessionId: string,
  status: string,
  flushedPaths: string[],
): Promise<void> {
  const env = await loadRunEnvelope(sessionId);
  if (!env) return;
  await saveRunEnvelope({ ...env, status: status as EnvelopeStatus, flushedPaths });
}

// ---- Listing ---------------------------------------------------------------

export async function listResumableEnvelopes(repoPath?: string): Promise<RunEnvelope[]> {
  const dir = envelopesDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: RunEnvelope[] = [];
  for (const file of files) {
    if (!file.endsWith(".envelope.json") || file.endsWith(".tmp")) continue;
    try {
      const raw = await fs.readFile(join(dir, file), "utf-8");
      const env = JSON.parse(raw) as RunEnvelope;
      if (env.version !== 1) continue;
      if (repoPath !== undefined && env.repoPath !== repoPath) continue;
      if (!isResumable(env)) continue;
      results.push(env);
    } catch {
      // skip corrupt files
    }
  }

  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results;
}

export async function latestResumableEnvelope(repoPath: string): Promise<RunEnvelope | null> {
  const list = await listResumableEnvelopes(repoPath);
  return list[0] ?? null;
}

/** Resolve a full session ID or 8-char prefix to the full session ID. */
export async function resolveEnvelopeId(idOrPrefix: string): Promise<string | null> {
  const dir = envelopesDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const suffix = ".envelope.json";
  // Exact match
  if (files.includes(`${idOrPrefix}${suffix}`)) return idOrPrefix;
  // Prefix match
  for (const file of files) {
    if (file.endsWith(suffix)) {
      const sessionId = file.slice(0, -suffix.length);
      if (sessionId.startsWith(idOrPrefix)) return sessionId;
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
  ].filter(Boolean);

  return lines.join("\n");
}

// ---- Coalescing writer -----------------------------------------------------

export interface CoalescingWriter {
  /** Fire-and-forget: queues a write; collapses concurrent requests. */
  trigger(): void;
  /** Waits for any in-flight write, then forces one final write. */
  forceFlush(): Promise<void>;
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

  return { trigger, forceFlush };
}
