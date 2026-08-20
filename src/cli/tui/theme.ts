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
 *
 * The palette pass (selection contrast): `selectionBackground` and `selectionForeground` are the
 * only roles fixed to hex here, because they are the only pairing where two independently
 * theme-relative colours are stacked and can collide — confirmed on a real terminal, six selected
 * rows across five modals were unreadable. `accent`, `caution`, `danger`, `success`, `muted`, and
 * `emphasis` were each individually checked for the same risk and found clear: the first four are
 * either genuinely semantic (should follow the terminal's own convention, including a user's own
 * accessibility remapping) or foreground-only with no app-painted background beneath them, where
 * the terminal's own fg/bg design contract is what keeps text legible. `emphasis` specifically
 * lost its selected-row-foreground job to the new `selectionForeground` rather than being fixed
 * itself — see both roles' own comments below for why moving `emphasis` wholesale would have
 * regressed its other two jobs (a modal section header, a bold diff line) on a light terminal.
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
  /** The spinner, rendering the brand mark's own diagonal in motion. Its only use. Same value as
   *  role.brand by coincidence of this pass's outcome, not by structural necessity — kept as its
   *  own role so the spinner's colour stays independently reasoned and independently revertible
   *  from the diff/banner treatment that introduced role.brand. */
  activity: "#22B3C4",
  /** Stronger-than-default text with no app-painted background beneath it: a modal section
   *  header, a highlighted value, a bold diff addition (DiffView.tsx). The terminal's own fg/bg
   *  design contract is what keeps it legible, which is what makes theme-relative still correct
   *  here. Selected-row foreground moved to role.selectionForeground (the selection-contrast
   *  pass) once that specific pairing — this role stacked on role.selectionBackground's fill —
   *  was confirmed to collide on a real terminal; this role no longer sits on any app-painted
   *  background anywhere. */
  emphasis: "white",
  /** Background fill for the selected row in a navigable list — never a text colour. Fixed hex,
   *  not theme-relative: paired with role.emphasis (also theme-relative) it rendered unreadable
   *  on a real terminal, the same defect class as role.surface's — two independently-resolved
   *  colours stacked with no contrast guarantee. Equals role.brand/role.activity's value by
   *  choice, not coincidence: the landing site's own CSS already pairs these two exact values
   *  together (`.term{background:var(--ink)}` with `.acc{color:var(--signal-bright)}` nested
   *  inside it — this hex as background, that one as foreground, shipping today), and it ties
   *  the selected state to the same brand teal Composer.tsx's palette already uses to mean "this
   *  is selected." Defined independently rather than as a reference to role.brand, per the
   *  precedent role.activity already set for itself — so the two can diverge later without
   *  coupling. */
  selectionBackground: "#22B3C4",
  /** The foreground for text rendered on top of role.selectionBackground's fill — never used
   *  standalone, and deliberately not role.emphasis (see role.emphasis's own comment: that role
   *  covers jobs with no app-painted background, and forcing it to a value chosen for this fill
   *  would have regressed those). Fixed hex for the same reason selectionBackground is one: this
   *  is the pairing that was confirmed colliding. Equals role.surface's value — 7.67:1 contrast
   *  against role.selectionBackground by the WCAG relative-luminance formula, comfortably past
   *  the 7:1 AAA floor for normal text — defined independently per the same role.activity
   *  precedent. */
  selectionForeground: "#0B0E0F",
  /** Quiet chrome borders, de-emphasized block text. */
  muted: "gray",
  /** Neutral background fill for a distinct content block. Fixed hex (the landing's `--ink`), not
   *  theme-relative, like `role.brand`/`role.activity` — a bare ANSI index such as `blackBright`
   *  is resolved entirely by the terminal's own colour scheme (confirmed: `ansi-styles` emits only
   *  the index, no RGB), and on at least one real theme it painted light grey, not dark, inverting
   *  the point of a "dark surface." A background whose only job is reading as dark cannot be
   *  theme-relative the way a semantic colour (danger/success/etc.) correctly is. */
  surface: "#0B0E0F",
  /** The landing site's teal brand identity (`--signal-bright` in the landing's own CSS) — used
   *  wherever the logo/mark motif itself appears: currently the diff view's marker accent
   *  (DiffView.tsx). The persistent startup banner (index.tsx's `writeBannerToStdout`) carries
   *  the same value too, but as a hardcoded raw-ANSI escape explained at that call site — it is
   *  outside the Ink tree and outside this seam entirely, so it cannot import this constant.
   *  Distinct from role.accent (generic UI chrome — modal borders, selection foreground, prompt
   *  markers) even though both read as cyan-family; reusing role.accent here would repaint every
   *  one of those unrelated surfaces to this exact hex, which no product decision has asked for. */
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
   *  flourish (IterMarker) — same character, same role, shorter run. Also the spinner's 180°
   *  rotation frame (the palette pass) — the diagonal mark, momentarily horizontal, is the same
   *  glyph as the rule rather than a disconnected local literal of the same character. */
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
