/**
 * The TUI's colour and glyph seam. Every value here is named by what it currently marks, not by
 * its appearance — a change to what the accent colour IS should not require touching every call
 * site that uses it, only this file. Values are unchanged from what each site rendered before
 * this module existed; this is an extraction, not a redesign.
 *
 * Separate from src/cli/colors.ts deliberately: that module emits raw ANSI escape sequences for
 * plain-stdout output (`\x1b[31m`, manually reset), while Ink's color/borderColor/backgroundColor
 * props take bare literal strings that Ink itself resolves, resets, and accounts for in layout.
 * The two renderers have no shared callers today; forcing one module to serve both would couple
 * them for no current benefit.
 *
 * `role.accent` (cyan) and `role.caution` (yellow) both mark modal chrome — border + title — on
 * different modals: `caution` on the ones that ask a yes/no risk decision, `accent` on the
 * informational/settings ones. `ApiKeysView` renders its title in `caution` despite being
 * structurally an informational/settings view like its `accent`-chrome siblings — extracted as-is
 * (byte-identical to before), flagged here rather than silently reclassified, which would change
 * what renders. Left for the palette pass.
 */

export const role = {
  /** Modal chrome (border + title) on informational/settings views; selection-state foreground
   *  in navigable lists; prompt and entry-marker glyphs. */
  accent: "cyan",
  /** Modal chrome on yes/no risk-decision prompts; notices and caveats; mid-level budget warning. */
  caution: "yellow",
  /** Destructive options, errors, failed tool calls, high budget warning. Diff removals moved to
   *  the background-weight treatment in DiffView.tsx (the palette pass) — no longer a consumer. */
  danger: "red",
  /** Affirmative options, successful tool calls, completed todos. Diff additions moved to the
   *  background-weight treatment in DiffView.tsx (the palette pass) — no longer a consumer. */
  success: "green",
  /** The spinner. Its only use. */
  activity: "magenta",
  /** Stronger-than-default text: section headers within a modal, selected-row foreground,
   *  a highlighted value. */
  emphasis: "white",
  /** Background fill for the selected row in a navigable list — never a text colour. */
  selectionBackground: "blue",
  /** Quiet chrome borders, de-emphasized block text. */
  muted: "gray",
  /** Neutral background fill for a distinct content block. */
  surface: "blackBright",
  /** The landing site's teal brand identity (`--signal-bright` in the landing's own CSS) — used
   *  wherever the logo/mark motif itself appears: the diff view's marker accent and the splash
   *  banner mark. Distinct from role.accent (generic UI chrome — modal borders, selection
   *  foreground, prompt markers) even though both read as cyan-family; reusing role.accent here
   *  would repaint every one of those unrelated surfaces to this exact hex, which no product
   *  decision has asked for. */
  brand: "#22B3C4",
} as const;

export const glyph = {
  /** The text-input cursor, rendered as a single inverted-looking block. Duplicated verbatim
   *  across every component with an editable text buffer. */
  cursor: "▋",
  /** Marks the first line of a multi-line transcript block. Structural — the colour that pairs
   *  with it (role.accent or role.muted) varies by entry kind; the glyph itself does not. */
  entryMarker: "◆ ",
  /** Horizontal rule, drawn to the terminal width. Also used undivided as a short decorative
   *  flourish (IterMarker) — same character, same role, shorter run. */
  separator: "─",
  /** List-item prefix. Appears both plain (a risk-hint line) and role.accent-coloured (a markdown
   *  list item) — the glyph is the shared part, the colour is not. */
  bullet: "• ",
  /** Paired with role.caution or role.danger at every site — a caveat, a blocked action, or a
   *  destructive-prompt title. */
  warningMark: "⚠",
  /** Uncoloured filled-circle marker: a plain bullet in a trust-prompt list, and the
   *  no-issue/no-preview status icon for a collapsed or successful tool call. */
  groupMarker: "●",
  /** Paired with role.danger at every site — a failed command or a failed tool call. */
  failureMark: "✗",
  /** Prefixes a detail/explanation line subordinate to the line above it. */
  detailConnector: "└ ",
  /** Paired with role.success at every site — a successful command or a completed todo. */
  successMark: "✓",
  /** The selection-row cursor in a navigable list. */
  selectionCursor: "▸ ",
  /** Marks a user-prompt transcript entry. Same character as selectionCursor, deliberately kept
   *  as its own name: this one is unconditional (always shown for this entry kind), not tied to
   *  a navigable selection state, and a future redesign may want to treat them differently. */
  promptMarker: "▸ ",
  /** Uncoloured — "no result yet" / "not started" marker. */
  pendingMark: "○",
  /** The up/down navigation hint, always rendered as one two-character unit, never split. */
  navigateArrows: "↑↓",
  /** Paired radio markers for a single-select list: the currently-active option vs. every other
   *  one. Always used as a pair — a list rendering one is rendering the other for its siblings. */
  radioSelected: "(•)",
  radioUnselected: "( )",
} as const;
