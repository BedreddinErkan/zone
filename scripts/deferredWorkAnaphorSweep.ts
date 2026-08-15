/**
 * The single source of truth for docs/deferred-work.md's anaphor sweep — item 126's own
 * convention, which every ledger pass had been reconstructing from prose and validating
 * circularly against its own recorded absolute (the reconstruction that returns 52 is "right"
 * because 52 is the recorded number, not because the pattern was re-derived from first
 * principles). Storing it here breaks that circularity: a deliberate change to the verb list
 * or the absolute is a visible diff to this file, not a shell command that leaves no trace.
 *
 * Operates on a string, not a file path — the ledger path lives in the test that calls this.
 */

/**
 * Six verbs, locked at item 126 and unchanged since. A reconstruction widened to thirteen
 * verbs returned 53 against the recorded 52 and was rejected on that ground alone — the lock
 * exists precisely so a miss is answered by asking whether the instrument could see the text,
 * not by adding a verb. Do not extend this list without a new ledger entry recording why.
 */
export const ANAPHOR_VERBS = [
  "closed",
  "fixed",
  "resolved",
  "corrected",
  "removed",
  "landed",
] as const;

/** Current confirmed count under all three instruments, at commit e6caf36f (item 126 / the
 *  thirty-second-pattern pass). Bumping this is the visible edit a deliberate ledger change
 *  to the referent count must produce. */
export const ANAPHOR_ABSOLUTE = 52;

/** The line-based and wrap-normalized counts must agree exactly. A nonzero gap means a
 *  referent is hidden by a soft wrap — see item 126 — not that the absolute moved. */
export const ANAPHOR_GAP_REQUIREMENT = 0;

/**
 * Built from ANAPHOR_VERBS rather than duplicated by hand. Every alternative uses a literal
 * space, never `\s` — that is what makes countLineBased correct without splitting the input by
 * line first: neither alternative can consume a real newline, so a global match on the raw
 * string already cannot cross a line boundary, the same guarantee `grep` gives by matching
 * within one physical line.
 */
export function buildAnaphorPattern(): RegExp {
  const verbAlternation = ANAPHOR_VERBS.join("|");
  return new RegExp(`(${verbAlternation}) there|the [a-z]+ above`, "g");
}

/** Matches within a line by construction (see buildAnaphorPattern's comment) — mirrors
 *  `command grep -E -o` / `git grep -E -o -h` counting non-overlapping matches. */
export function countLineBased(text: string): number {
  return (text.match(buildAnaphorPattern()) ?? []).length;
}

/**
 * Paragraph-join instrument (item 126's amendment): splits on blank-line boundaries, joins
 * each paragraph's own internal newlines with a space, and counts matches per paragraph. A
 * referent whose words fall either side of a soft wrap becomes visible here even though it is
 * invisible to countLineBased; collapsing is scoped to one paragraph so it cannot manufacture
 * a match across two.
 */
export function countWrapNormalized(text: string): number {
  const paragraphs = text.split(/\n\s*\n/);
  const pattern = buildAnaphorPattern();
  let total = 0;
  for (const paragraph of paragraphs) {
    const joined = paragraph.replace(/\n/g, " ");
    total += (joined.match(pattern) ?? []).length;
  }
  return total;
}

export interface AnaphorSweepResult {
  lineBased: number;
  wrapNormalized: number;
  gap: number;
}

/** Convenience wrapper — what a ledger pass should call instead of writing either counter by
 *  hand again. */
export function sweep(text: string): AnaphorSweepResult {
  const lineBased = countLineBased(text);
  const wrapNormalized = countWrapNormalized(text);
  return { lineBased, wrapNormalized, gap: wrapNormalized - lineBased };
}
