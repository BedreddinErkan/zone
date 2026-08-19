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
  /** Destructive options, errors, failed tool calls, diff removals, high budget warning. */
  danger: "red",
  /** Affirmative options, diff additions, successful tool calls, completed todos. */
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
} as const;

export const glyph = {
  /** The text-input cursor, rendered as a single inverted-looking block. Duplicated verbatim
   *  across every component with an editable text buffer. */
  cursor: "▋",
  /** Marks the first line of a multi-line transcript block. Structural — the colour that pairs
   *  with it (role.accent or role.muted) varies by entry kind; the glyph itself does not. */
  entryMarker: "◆ ",
  /** Horizontal rule, drawn to the terminal width. */
  separator: "─",
  /** List-item prefix. Appears both plain (a risk-hint line) and role.accent-coloured (a markdown
   *  list item) — the glyph is the shared part, the colour is not. */
  bullet: "• ",
} as const;
