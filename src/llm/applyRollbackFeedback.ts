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
  [
    "IndentationError",
    "Suggested: fix indentation — Python requires consistent spaces or tabs, not a mix.",
  ],
  [
    "TabError",
    "Suggested: replace tabs with spaces (or vice versa) — Python cannot mix indentation styles.",
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
 * J.4.1: which heuristic code (if any) produced the suggestion. Returns
 * the matched error code (e.g. "TS2305") or null when no heuristic
 * code is present. Used for telemetry so we can see whether a rollback
 * carried an actionable hint without re-parsing the rendered message.
 */
export function pickRolledBackSuggestionCode(
  errors: ReadonlyArray<RolledBackError>
): string | null {
  for (const e of errors) {
    if (ROLLED_BACK_SUGGESTIONS.has(e.code)) return e.code;
  }
  return null;
}

/**
 * J.4.1: strip ANSI color/SGR escape sequences. tsc emits coloured
 * output in some environments (npm script wrappers, FORCE_COLOR,
 * modern bundler integrations) even when stdout isn't a TTY. The
 * J.4 (pre-J.4.1) regex didn't account for that, so the codes were
 * extracted as `code:""` and the heuristic always missed.
 */
function stripAnsi(s: string): string {
  // ANSI/SGR pattern: ESC (0x1B) + \[\ + numeric/; params + terminator letter.
  // Built dynamically so the source file stays free of literal control chars
  // (some editors / tooling normalize them away).
  const esc = String.fromCharCode(0x1b);
  const ansiPattern = new RegExp(esc + '\\[[0-9;]*[A-Za-z]', 'g');
  return s.replace(ansiPattern, '');
}

/**
 * Parse a verification command's error preview into structured rows.
 *
 * Recognizes BOTH tsc output formats (J.4.1 hardening):
 *   - Legacy:  `path(line,col): error TS####: <message>`     ← tsc default when piped
 *   - Pretty:  `path:line:col - error TS####: <message>`     ← tsc --pretty + many wrappers
 *
 * Plus an `error TS####:`-anywhere fallback so a code is still extracted
 * even when the line has unfamiliar prefix/suffix decoration (build
 * wrappers, indentation, "ERROR in file:" preludes). Lines that match
 * none of the above drop into a `code:"", message:<rawLine>` row so
 * non-tsc verifiers (vitest/jest summaries) still surface readable output.
 */
export function parseTscErrorPreview(preview: string): RolledBackError[] {
  const out: RolledBackError[] = [];
  for (const raw of String(preview ?? "").split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (!line) continue;
    // 1) Legacy: src/foo.ts(12,5): error TS2305: Module ... has no exported member 'baz'.
    const legacy = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/);
    if (legacy) {
      out.push({
        file: legacy[1],
        line: Number(legacy[2]),
        col: Number(legacy[3]),
        code: legacy[4]!,
        message: legacy[5]!,
      });
      continue;
    }
    // 2) Pretty: src/foo.ts:12:5 - error TS2305: Module ... (note: `-` separator, `:` not `(...)`).
    //    Anchor the file segment so a stray colon in the message can't be misread as `file:line:col`.
    const pretty = line.match(/^(\S.+?):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.+)$/);
    if (pretty) {
      out.push({
        file: pretty[1],
        line: Number(pretty[2]),
        col: Number(pretty[3]),
        code: pretty[4]!,
        message: pretty[5]!,
      });
      continue;
    }
    // 3) Fallback: TS code visible anywhere in the line. Captures the code
    //    even when file/line/col are missing or in an unrecognized shape —
    //    crucial for the heuristic lookup, which only needs `code`.
    const codeOnly = line.match(/\berror\s+(TS\d+):?\s*(.*)$/);
    if (codeOnly) {
      out.push({ code: codeOnly[1]!, message: codeOnly[2] || line });
      continue;
    }
    // 4) Non-tsc lines (vitest summary, etc.) — surface raw text.
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

/**
 * J.4 C2: true when the rendered rollback message includes a "Suggested:"
 * line from the cross-file heuristic. Useful for downstream consumers
 * (orchestrator, telemetry) that want to gate retry behavior on whether
 * the agent has an actionable hint vs. needs to investigate from scratch.
 */
export function applyRolledBackMessageHasSuggestion(msg: string): boolean {
  if (!isApplyRolledBackMessage(msg)) return false;
  return /\nSuggested: /.test(msg);
}

/**
 * J.4.1: shape for the `[zone-apply-rolled-back-marker]` diagnostic log
 * payload. Centralized so the three rollback callsites
 * (agentLoop.natural_completion, agentLoop.max_iter,
 *  toolExecutor.inline_ts_check) emit a consistent record.
 */
export interface ApplyRolledBackMarkerLog {
  /** Where in the loop the rollback originated. */
  site: "natural_completion" | "max_iter" | "inline_ts_check";
  /** First 200 chars of the rendered marker — grep-friendly. */
  markerPreview: string;
  /** Number of parsed errors. */
  errorCount: number;
  /** Distinct TS error codes extracted (e.g. ["TS2305","TS2304"]). */
  errorCodes: string[];
  /** The error code that triggered the heuristic suggestion, or null. */
  suggestionApplied: string | null;
  /** Files restored to pre-apply state. */
  filePathsRestored: string[];
  /** Run id (optional — may be null for synthetic / test contexts). */
  runId: string | null;
}

/**
 * J.5: cross-run summary threading helpers.
 *
 * A patch run that ended in a rollback gets its loop.summary persisted to
 * the conversation as a {type:"agent_summary", text, ts, decisionMode}
 * event. The next run loads the latest such event and threads it into the
 * new agentLoop as `priorRunSummary` so the agent reads the prior
 * APPLY_ROLLED_BACK marker before re-investigating.
 *
 * These helpers live alongside the marker code because the
 * marker-preservation rule is what gives the truncation step its shape.
 */

/** Soft cap for priorRunSummary injection — keeps prompt overhead bounded. */
export const PRIOR_RUN_SUMMARY_MAX_BYTES = 2048;

/**
 * Truncate a prior summary to `PRIOR_RUN_SUMMARY_MAX_BYTES` while
 * preserving the trailing APPLY_ROLLED_BACK block if present (the
 * marker is the agent-actionable part).
 *
 * Rules:
 *   - length ≤ cap → return as-is
 *   - has marker and the *entire* marker block fits → slice so the marker
 *     starts at offset 0; prepend a short truncation notice
 *   - has marker but marker block alone exceeds cap → return just the
 *     marker block trimmed to cap (best-effort; full marker is more
 *     valuable than the prelude)
 *   - no marker → keep the tail (last cap bytes); prepend truncation notice
 */
export function truncatePriorRunSummary(summary: string): string {
  const s = String(summary ?? "");
  if (s.length <= PRIOR_RUN_SUMMARY_MAX_BYTES) return s;
  const NOTICE = "[…prior summary truncated to most-relevant tail…]\n";
  const markerIdx = s.lastIndexOf(`${MARKER}\n`);
  if (markerIdx >= 0) {
    const markerBlock = s.slice(markerIdx);
    if (markerBlock.length <= PRIOR_RUN_SUMMARY_MAX_BYTES - NOTICE.length) {
      return NOTICE + markerBlock;
    }
    // Marker alone exceeds cap — return the start of the marker (it's the
    // important head; the trailing detail is bounded by errors[] anyway).
    return markerBlock.slice(0, PRIOR_RUN_SUMMARY_MAX_BYTES);
  }
  return NOTICE + s.slice(-(PRIOR_RUN_SUMMARY_MAX_BYTES - NOTICE.length));
}

/**
 * Scan a persisted conversation's `messages` array (typed-event shape, as
 * stored by appendConversationMessages) for the most recent
 * {type: "agent_summary"} event and return its text — empty when none.
 *
 * Tolerates absent / malformed entries (returns "" rather than throwing).
 */
export function extractPriorRunSummary(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const obj = m as { type?: unknown; text?: unknown };
    if (obj.type !== "agent_summary") continue;
    const text = typeof obj.text === "string" ? obj.text : "";
    if (!text) return "";
    return truncatePriorRunSummary(text);
  }
  return "";
}

/** Build the diagnostic payload from the message + parsed errors. */
export function buildApplyRolledBackMarkerLog(input: {
  site: ApplyRolledBackMarkerLog["site"];
  markerMessage: string;
  errors: ReadonlyArray<RolledBackError>;
  filePathsRestored: ReadonlyArray<string>;
  runId: string | null;
}): ApplyRolledBackMarkerLog {
  const codes = Array.from(new Set(input.errors.map((e) => e.code).filter(Boolean)));
  return {
    site: input.site,
    markerPreview: String(input.markerMessage ?? "").slice(0, 200),
    errorCount: input.errors.length,
    errorCodes: codes,
    suggestionApplied: pickRolledBackSuggestionCode(input.errors),
    filePathsRestored: [...input.filePathsRestored],
    runId: input.runId,
  };
}
