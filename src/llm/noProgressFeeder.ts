import { parseTscErrorPreview, parseTestFailures } from "./applyRollbackFeedback.js";
import { buildErrorKeySet } from "./verification/classify.js";

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
