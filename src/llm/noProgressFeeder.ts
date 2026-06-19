import { parseTscErrorPreview, parseTestFailures } from "./applyRollbackFeedback.js";
import { buildErrorKeySet } from "./verification/classify.js";
import type { ErrorKeySnapshot } from "./antiThrash.js";

/**
 * Classify a run_command command string as a tsc type-check, a test run, or neither.
 * If both patterns match (unlikely), prefers "tsc".
 * Returns null for incidental mentions (grep, echo, etc.) — gates on command shape.
 */
export function classifyVerifyCommand(command: string): "tsc" | "test" | null {
  const isTsc =
    (/\btsc\b/.test(command) && (/--noemit/i.test(command) || /\btypecheck\b/.test(command))) ||
    /\bnpm(\s+run)?\s+(typecheck|tsc)\b/.test(command);

  if (isTsc) return "tsc";

  const isTest =
    /\b(vitest|jest|pytest|mocha)\b/.test(command) ||
    /\bnpm(\s+run)?\s+(?:test(?::[a-z0-9-]+)?|playwright)\b/.test(command);

  if (isTest) return "test";

  return null;
}

/**
 * Parse a run_command's output into an error key-set for P3 snapshot construction.
 * "tsc" → parseTscErrorPreview; "test" → parseTestFailures.
 * Returns empty Set when nothing parses (safe — feeder discards empty snapshots).
 */
export function parseVerifyOutputToKeySet(
  kind: "tsc" | "test",
  output: string,
  repoPath?: string,
): Set<string> {
  if (kind === "tsc") {
    return buildErrorKeySet(parseTscErrorPreview(output).filter((e) => e.code !== ""));
  }
  return buildErrorKeySet(parseTestFailures(output, repoPath).filter((e) => e.code !== ""));
}

/**
 * True when the run_command output was truncated by truncateCommandOutput.
 * Telemetry metadata only — the detector does not read this field.
 */
export function detectTruncation(output: string): boolean {
  return /\[\.\.\..*lines truncated for context budget/.test(output);
}

/**
 * Pure decision: given the parsed key-set and run state, determine what the feeder should do.
 * Applies=0: capture baseline (once). Applies>0: compute introduced keys and push a snapshot.
 */
export function computeFeederAction(
  postKeys: Set<string>,
  successfulApplies: number,
  baseline: Set<string> | null,
  iter: number,
  truncated: boolean,
): { kind: "setBaseline"; keys: Set<string> }
  | { kind: "pushSnapshot"; snapshot: ErrorKeySnapshot }
  | { kind: "skip" } {
  if (successfulApplies === 0) {
    return baseline === null
      ? { kind: "setBaseline", keys: postKeys }
      : { kind: "skip" };
  }
  const base = baseline ?? new Set<string>();
  const introducedKeys = [...postKeys].filter((k) => !base.has(k)).sort();
  if (introducedKeys.length === 0) return { kind: "skip" };
  return {
    kind: "pushSnapshot",
    snapshot: { iter, introducedKeys, successfulAppliesAtCapture: successfulApplies, truncated },
  };
}
