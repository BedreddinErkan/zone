/**
 * Phase Q.2: runtime loop detection.
 *
 * Sliding-window detector that catches an agent calling the same tool with
 * the same arguments repeatedly mid-run. Two response layers:
 *  - count === WARN_THRESHOLD (3): warn the model via injected context message
 *  - count >= TERMINATE_THRESHOLD (5): graceful exit, no further LLM call
 *
 * Pure functions; caller (agentLoop) owns the DetectorState per-run.
 */

export const WINDOW_SIZE = 8;
export const WARN_THRESHOLD = 3;
export const TERMINATE_THRESHOLD = 5;

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

/** Stable identity for a tool call. Same (tool, args) → same hash, even when
 *  caller passed args with keys in a different order. */
export function hashToolCall(toolName: string, args: unknown): string {
  return String(toolName) + ":" + JSON.stringify(canonicalize(args ?? {}));
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
