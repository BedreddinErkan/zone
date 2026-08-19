/**
 * Returns true when a terminal resize from prevCols to nextCols warrants the clear+remount path —
 * on ANY column change, in either direction.
 *
 * This was narrowing-only, on the premise that "widening is self-correcting (Ink over-erases the
 * taller previous frame)". That premise is wrong, and was measured wrong rather than argued: Ink's
 * own resize handler recalculates Yoga layout and repaints, but never re-invokes React components
 * (render count stays flat across a resize). So flex-positioned content follows the new width
 * while anything computed from `columns` inside a component body — a separator string, an explicit
 * `width=` prop, the Static width — stays frozen at whatever width was current when that component
 * last rendered. Widening only *looked* self-correcting because a stale-too-wide value is
 * un-clipped rather than reflowed; committed transcript history stayed laid out for the old width.
 *
 * The clear+remount path already fixed all of that. It simply never fired on widening. Firing it
 * on any change reflows committed history and, because a store change re-renders every consumer,
 * refreshes the live region's widths too.
 *
 * Height-only resizes never change columns, so they still return false.
 * Returns false on any invalid (non-positive-finite) argument.
 */
export function shouldRedrawOnResize(prevCols: number, nextCols: number): boolean {
  if (!Number.isFinite(prevCols) || prevCols <= 0) return false;
  if (!Number.isFinite(nextCols) || nextCols <= 0) return false;
  return nextCols !== prevCols;
}

/** Clear screen + scrollback + cursor home. */
export const CLEAR_SCREEN_AND_SCROLLBACK = "\x1b[2J\x1b[3J\x1b[H";

/**
 * The redraw itself: clear, then remount. Extracted from the inline handler in index.tsx purely so
 * the PAIRING is testable — the two halves are load-bearing together and silently broken apart.
 * Deleting the clear while keeping the remount survived the entire suite when it was inline, and
 * would put a second copy of the whole transcript on screen at every resize, which this pass makes
 * twice as frequent by acting on widening too.
 *
 * Order matters and is asserted: clearing after the remount would wipe the fresh copy.
 */
export function applyResizeRedraw(
  write: (s: string) => void,
  remount: () => void,
): void {
  write(CLEAR_SCREEN_AND_SCROLLBACK);
  remount();
}
