/**
 * Phase Q.2: runtime loop detection.
 *
 * Sliding-window detector that catches an agent calling the same tool with
 * the same arguments repeatedly mid-run. Two response layers:
 *  - count === WARN_THRESHOLD (3): warn the model via injected context message
 *  - count >= TERMINATE_THRESHOLD (4): graceful exit, no further LLM call
 *
 * Identity includes workspace state: two identical calls made against different
 * staged content are different calls, because the second one can return a
 * different result. Without this, a red-green cycle (test → fix → test → fix →
 * test) reaches four identical `npm test` hashes inside the 8-call window and
 * terminates a run that is converging normally.
 *
 * Pure functions; caller (agentLoop) owns the DetectorState per-run.
 */

import { createHash } from "node:crypto";

export const WINDOW_SIZE = 8;
export const WARN_THRESHOLD = 3;
export const TERMINATE_THRESHOLD = 4;

/** Tools whose repeated identical calls are semantically legitimate (e.g. polling a
 *  background process handle). Excluded from loop detection at both call sites. */
export const LOOP_DETECT_EXEMPT_TOOLS = new Set(["read_background_output"]);

export type DetectorStatus = "ok" | "warn" | "terminate";

export interface DetectorState {
  /** Most recent up-to-WINDOW_SIZE tool-call hashes, oldest first. */
  window: string[];
}

export interface DetectorResult {
  status: DetectorStatus;
  count: number;
}

/** Recursively sort object keys so logically-equal args hash identically
 *  regardless of insertion order. Arrays preserve order. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    out[k] = canonicalize(obj[k]);
  }
  return out;
}

/**
 * Fingerprint of the staged workspace: order-independent over paths, sensitive to
 * content. Shared with toolExecutor's command memoizer so the two subsystems agree
 * on what makes two identical invocations "the same call".
 */
export function hashStagingState(stagingFiles: Map<string, string> | undefined): string {
  const sortedEntries = Array.from((stagingFiles ?? new Map<string, string>()).entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return createHash("sha256").update(JSON.stringify(sortedEntries)).digest("hex").slice(0, 16);
}

/** Stable identity for a tool call. Same (tool, args, workspace) → same hash, even
 *  when caller passed args with keys in a different order. `workspaceState` is the
 *  hashStagingState fingerprint; omitting it reproduces the pre-workspace behavior
 *  (used by callers that have no staging map, and by existing callers under test). */
export function hashToolCall(toolName: string, args: unknown, workspaceState?: string): string {
  const base = String(toolName) + ":" + JSON.stringify(canonicalize(args ?? {}));
  return workspaceState ? `${base}|${workspaceState}` : base;
}

export function createDetectorState(): DetectorState {
  return { window: [] };
}

/**
 * Append `hash` to the rolling window, then return how many times it occurs
 * within the window and which response layer (if any) the count triggers.
 *
 * Status mapping:
 *  - count < WARN_THRESHOLD      → "ok"
 *  - count === WARN_THRESHOLD    → "warn"  (fire once at exactly 3)
 *  - WARN < count < TERMINATE    → "ok"    (warning already fired)
 *  - count >= TERMINATE_THRESHOLD → "terminate"
 */
export function recordAndDetect(state: DetectorState, hash: string): DetectorResult {
  state.window.push(hash);
  if (state.window.length > WINDOW_SIZE) {
    state.window.splice(0, state.window.length - WINDOW_SIZE);
  }
  let count = 0;
  for (const h of state.window) {
    if (h === hash) count += 1;
  }
  let status: DetectorStatus = "ok";
  if (count >= TERMINATE_THRESHOLD) {
    status = "terminate";
  } else if (count === WARN_THRESHOLD) {
    status = "warn";
  }
  return { status, count };
}
