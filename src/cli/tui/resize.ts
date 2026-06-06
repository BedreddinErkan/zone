/**
 * Returns true when a terminal resize from prevCols to nextCols warrants the
 * clear+remount path (narrowing only — ghost rows accumulate when full-width
 * lines reflow into more physical rows than Ink erases).
 *
 * Widening is self-correcting (Ink over-erases the taller previous frame).
 * Height-only resizes never change columns.
 * Returns false on any invalid (non-positive-finite) argument.
 */
export function shouldRedrawOnResize(prevCols: number, nextCols: number): boolean {
  if (!Number.isFinite(prevCols) || prevCols <= 0) return false;
  if (!Number.isFinite(nextCols) || nextCols <= 0) return false;
  return nextCols < prevCols;
}
