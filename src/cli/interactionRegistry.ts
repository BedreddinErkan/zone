/**
 * Phase 6b — unified interaction registry.
 *
 * Replaces six module-level Map singletons (commandApprovals, editApprovals,
 * stagedApprovals, questionApprovals, planApprovals, revisionApprovals, trustApprovals)
 * with one registry that provides:
 * - Typed kinds for each interaction type
 * - Centralized abort cleanup via abortAll()
 * - Consistent pending-count accounting
 * - No parked promise can outlive the session
 *
 * Each module's public function signatures are preserved (call-site migration is out of scope).
 * The modules delegate to this registry instead of maintaining their own Maps.
 */

export type InteractionKind =
  | "command_approval"
  | "edit_approval"
  | "staged_diff"
  | "question"
  | "plan_ready"
  | "plan_revision"
  | "trust";

interface PendingEntry {
  kind: InteractionKind;
  id: string;
  runId?: string;
  resolve: (value: any) => void;
  timeout?: NodeJS.Timeout;
  abortCleanup?: () => void;
  /** Custom result for abort rejection (defaults to false). */
  abortResult?: any;
}

const pending = new Map<string, PendingEntry>();

function key(kind: InteractionKind, id: string): string {
  return `${kind}:${id}`;
}

/** Park a promise until resolve/abort. Returns the id for later resolution. */
export function request<T>(
  kind: InteractionKind,
  id: string,
  payload: {
    runId?: string;
    resolve: (value: T) => void;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    timeoutResult?: T;
    /** Custom result passed to resolve() when the abort signal fires. Defaults to false. */
    abortResult?: T;
  },
): void {
  const k = key(kind, id);
  if (pending.has(k)) return; // idempotent — don't double-register

  const entry: PendingEntry = {
    kind,
    id,
    runId: payload.runId,
    resolve: payload.resolve,
    abortResult: payload.abortResult,
  };

  // Timeout
  if (payload.timeoutMs && payload.timeoutMs > 0 && payload.timeoutResult !== undefined) {
    entry.timeout = setTimeout(() => {
      const e = pending.get(k);
      if (e) {
        pending.delete(k);
        e.resolve(payload.timeoutResult);
      }
    }, payload.timeoutMs);
  }

  // Abort signal wiring
  if (payload.abortSignal) {
    if (payload.abortSignal.aborted) {
      // Already aborted — resolve immediately with abortResult (or false)
      payload.resolve((payload.abortResult !== undefined ? payload.abortResult : false) as T);
      return;
    }
    const onAbort = (): void => {
      try { payload.abortSignal?.removeEventListener("abort", onAbort); } catch {}
      const e = pending.get(k);
      if (e) {
        pending.delete(k);
        if (e.timeout) clearTimeout(e.timeout);
        e.resolve(e.abortResult !== undefined ? e.abortResult : false);
      }
    };
    try { payload.abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    entry.abortCleanup = () => {
      try { payload.abortSignal?.removeEventListener("abort", onAbort); } catch {}
    };
  }

  pending.set(k, entry);
}

/** Resolve a pending interaction. Returns true if found and resolved. */
export function resolve<T>(kind: InteractionKind, id: string, result: T): boolean {
  const k = key(kind, id);
  const entry = pending.get(k);
  if (!entry) return false;
  pending.delete(k);
  if (entry.timeout) clearTimeout(entry.timeout);
  if (entry.abortCleanup) entry.abortCleanup();
  entry.resolve(result);
  return true;
}

/** Reject a pending interaction (alias for resolve with a rejection-like value). */
export function reject(kind: InteractionKind, id: string, result: any): boolean {
  return resolve(kind, id, result);
}

/** Abort a specific pending interaction. */
export function abort(kind: InteractionKind, id: string): boolean {
  const k = key(kind, id);
  const entry = pending.get(k);
  if (!entry) return false;
  pending.delete(k);
  if (entry.timeout) clearTimeout(entry.timeout);
  if (entry.abortCleanup) entry.abortCleanup();
  entry.resolve(false);
  return true;
}

/** Reject all pending interactions. Called on session end / process exit. */
export function abortAll(_reason: string): number {
  let count = 0;
  for (const [k, entry] of Array.from(pending.entries())) {
    pending.delete(k);
    if (entry.timeout) clearTimeout(entry.timeout);
    if (entry.abortCleanup) entry.abortCleanup();
    try { entry.resolve(entry.abortResult !== undefined ? entry.abortResult : false); } catch {}
    count++;
  }
  return count;
}

/** Count pending interactions, optionally filtered by kind. */
export function pendingCount(kind?: InteractionKind): number {
  if (!kind) return pending.size;
  let count = 0;
  for (const entry of pending.values()) {
    if (entry.kind === kind) count++;
  }
  return count;
}

/** Reject all pending interactions for a specific runId. Returns count rejected. */
export function rejectAllForRun(runId: string): number {
  const rid = String(runId || "").trim();
  if (!rid) return 0;
  let count = 0;
  for (const [k, entry] of Array.from(pending.entries())) {
    if (entry.runId === rid) {
      pending.delete(k);
      if (entry.timeout) clearTimeout(entry.timeout);
      if (entry.abortCleanup) entry.abortCleanup();
      try { entry.resolve(false); } catch {}
      count++;
    }
  }
  return count;
}

/** Reject all pending interactions matching a kind and runId. Returns count rejected. */
export function rejectByKindAndRun(kind: InteractionKind, runId: string): number {
  const rid = String(runId || "").trim();
  if (!rid) return 0;
  let count = 0;
  for (const [k, entry] of Array.from(pending.entries())) {
    if (entry.kind === kind && entry.runId === rid) {
      pending.delete(k);
      if (entry.timeout) clearTimeout(entry.timeout);
      if (entry.abortCleanup) entry.abortCleanup();
      try { entry.resolve(entry.abortResult !== undefined ? entry.abortResult : false); } catch {}
      count++;
    }
  }
  return count;
}

/** Test-only: check if a specific entry exists. */
export function _hasPending(kind: InteractionKind, id: string): boolean {
  return pending.has(key(kind, id));
}
