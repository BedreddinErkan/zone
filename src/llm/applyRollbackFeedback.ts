/**
 * Phase J.4 — structured rollback feedback for the agent.
 *
 * When an apply_patch's downstream verification regresses (or an inline
 * TS check trips), the system reverts staged content. Pre-J.4, the
 * agent saw either a freeform markdown summary append or a generic
 * SYNTAX_ERROR string — neither parseable, neither hinting at the
 * cross-file coordination problem most rollbacks indicate.
 *
 * `buildApplyRolledBackMessage()` produces a stable, parseable block
 * starting with the `APPLY_ROLLED_BACK` marker line, listing up to 5
 * errors, the files restored to pre-apply state, and (when the error
 * codes match a small heuristic table) a suggested next action.
 *
 * The marker convention is documented in the agent system prompt
 * (assembleAgentSystemPrompt, agentLoop.ts) so the agent recognizes
 * the structure and avoids the historical anti-pattern of shell-hacking
 * past the rollback.
 */

/** Single parsed error from the verification command's output. */
export interface RolledBackError {
  file?: string;
  line?: number;
  col?: number;
  /** TS error code, e.g. "TS2305". Empty when not a tsc-style line. */
  code: string;
  /** Human-readable message. */
  message: string;
}

const MAX_ERRORS_RENDERED = 5;
const MARKER = "APPLY_ROLLED_BACK";

/**
 * J.4 C2: a small, intentional heuristic mapping common cross-file
 * regression codes to a one-line suggestion. Other codes get no
 * suggestion — silence is better than noise.
 *
 * Exported for unit-test coverage so the table is the single source of
 * truth (no string duplication in tests).
 */
export const ROLLED_BACK_SUGGESTIONS: ReadonlyMap<string, string> = new Map([
  [
    "TS2305",
    "Suggested: the rename is partial; complete in dependent files via a single coordinated patch sequence using the Task tool for fan-out.",
  ],
  [
    "TS2304",
    "Suggested: identifier is not yet defined or imported; verify all required updates are bundled.",
  ],
  [
    "TS2339",
    "Suggested: type contract changed; update all consumers in the same patch sequence.",
  ],
]);

/**
 * Pick the first matching suggestion from the heuristic table. Returns
 * empty string when no error code matches — the caller omits the line
 * entirely rather than emitting a placeholder.
 */
export function pickRolledBackSuggestion(errors: ReadonlyArray<RolledBackError>): string {
  for (const e of errors) {
    const s = ROLLED_BACK_SUGGESTIONS.get(e.code);
    if (s) return s;
  }
  return "";
}

/**
 * Parse a verification command's error preview into structured rows.
 * Recognizes the tsc default form `<file>(<line>,<col>): error TS####: <message>`.
 * Lines that don't match drop into a `code:"", message:<rawLine>` row so
 * non-tsc verifiers still surface readable output.
 */
export function parseTscErrorPreview(preview: string): RolledBackError[] {
  const out: RolledBackError[] = [];
  for (const raw of String(preview ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // src/foo.ts(12,5): error TS2305: Module '"./bar"' has no exported member 'baz'.
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/);
    if (m) {
      out.push({
        file: m[1],
        line: Number(m[2]),
        col: Number(m[3]),
        code: m[4]!,
        message: m[5]!,
      });
      continue;
    }
    // Non-tsc lines (e.g. jest/vitest summary) — surface raw text.
    out.push({ code: "", message: line });
  }
  return out;
}

export interface BuildApplyRolledBackInput {
  /** filePath the agent's apply_patch targeted (or "<multiple>" for end-of-loop bundle rollbacks). */
  filePath: string;
  /** Parsed errors from the verification step. */
  errors: ReadonlyArray<RolledBackError>;
  /** Absolute paths (or repo-relative) of files restored to pre-apply state. */
  restoredFiles: ReadonlyArray<string>;
}

/**
 * Render a structured tool_result body for the agent to consume.
 *
 * Shape (stable — agent prompt documents this exact form):
 *
 *   APPLY_ROLLED_BACK
 *   Your apply_patch on <filePath> was rolled back.
 *
 *   Reason: post-apply verification introduced N new error(s):
 *     <file>(<line>,<col>): <code>: <message>
 *     <up to 5 errors>
 *     (plus K more)  ← only when errors.length > 5
 *
 *   Files restored to pre-apply state: [<path>, <path>, ...]
 *
 *   <suggestion line>  ← only when heuristic matches
 *
 *   Disk is at the pre-apply state. Re-investigate before re-attempting.
 */
export function buildApplyRolledBackMessage(input: BuildApplyRolledBackInput): string {
  const total = input.errors.length;
  const head = input.errors.slice(0, MAX_ERRORS_RENDERED);
  const more = Math.max(0, total - MAX_ERRORS_RENDERED);
  const formatRow = (e: RolledBackError): string => {
    if (e.file && Number.isFinite(e.line) && Number.isFinite(e.col) && e.code) {
      return `  ${e.file}(${e.line},${e.col}): ${e.code}: ${e.message}`;
    }
    if (e.code) return `  ${e.code}: ${e.message}`;
    return `  ${e.message}`;
  };
  const errorLines = head.map(formatRow).join("\n");
  const moreLine = more > 0 ? `\n  (plus ${more} more)` : "";
  const restoredJson = JSON.stringify(input.restoredFiles);
  const suggestion = pickRolledBackSuggestion(input.errors);
  const suggestionBlock = suggestion ? `\n\n${suggestion}` : "";

  return (
    `${MARKER}\n` +
    `Your apply_patch on ${input.filePath} was rolled back.\n\n` +
    `Reason: post-apply verification introduced ${total} new error(s):\n` +
    `${errorLines}${moreLine}\n\n` +
    `Files restored to pre-apply state: ${restoredJson}` +
    `${suggestionBlock}\n\n` +
    `Disk is at the pre-apply state. Re-investigate before re-attempting.`
  );
}

/** Test predicate — true when a string carries the J.4 marker. */
export function isApplyRolledBackMessage(s: string): boolean {
  return String(s ?? "").startsWith(`${MARKER}\n`);
}
