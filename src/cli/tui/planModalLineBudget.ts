/**
 * Computes PlanReadyModal's content-line budget from the terminal's row
 * count. `rows` is typed `unknown` because it comes straight from
 * `stdout.rows`, which can be an implausible value from a mock or an unusual
 * pty — the caller gets both a validity flag and the verbatim received value
 * so it can report on exactly what came in, rather than falling back
 * silently with nothing to show for it.
 *
 * `footerLines` and `siblingLines` are plain parameters, not read internally
 * — callers own their own footer/sibling reservations.
 */
const DEFAULT_ROWS = 24;           // Ink's own non-TTY fallback — ink.js:695
const COMPACT_ROWS_THRESHOLD = 30; // below this, callers may switch to compact chrome
const FRAME_CHROME_LINES = 11;     // PLACEHOLDER — pending direct measurement against
                                    // the real rendered frame; not yet pinned

export function planModalLineBudget(
  rows: unknown,
  footerLines: number,
  siblingLines: number,
): { contentBudget: number; compact: boolean; rowsValid: boolean; receivedRows: unknown } {
  const isValid =
    typeof rows === "number" && Number.isFinite(rows) && Number.isInteger(rows) && rows > 0;
  const effectiveRows = isValid ? rows : DEFAULT_ROWS;
  const compact = effectiveRows < COMPACT_ROWS_THRESHOLD;
  // Chrome is unconditionally FRAME_CHROME_LINES here — a compact-mode branch
  // has no business existing until the compact markup itself exists and has
  // been measured through it.
  return {
    contentBudget: effectiveRows - FRAME_CHROME_LINES - footerLines - siblingLines,
    compact,
    rowsValid: isValid,
    receivedRows: rows,
  };
}
