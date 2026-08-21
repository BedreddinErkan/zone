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
 *  to the referent count must produce.
 *
 *  Re-verified unchanged at 52 after buildAnaphorPattern gained word-boundary anchors on all
 *  four open edges (verb-left, there-right, the-left, above-right) — checked by diffing match
 *  SPANS (start index + matched text) between the old and new pattern on the live document, not
 *  just comparing counts, so a false-positive-for-false-positive swap could not hide behind an
 *  equal total. The two 52-element span lists were byte-identical: zero matches added, zero
 *  removed. The gap the boundaries close was real and exploitable — "landed there" also matched
 *  inside "landed therefore" — but had not contaminated this absolute; the fix is preventative
 *  hardening, not a retroactive correction. See buildAnaphorPattern's own comment for the four
 *  edges and scripts/deferredWorkAnaphorSweep.test.ts's fixture tests for one regression pin
 *  per edge. */
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
 *
 * WHAT THIS COVERS: four word-boundary-anchored edges, one pair per alternative —
 * `\b(verb) there\b` and `\bthe [a-z]+ above\b`. Each `\b` closes a real, swept gap, not a
 * defensive guess:
 *  - Left of the verb group: an unanchored alternation matches "closed" inside "disclosed" —
 *    swept for every word in the document ending in one of the six verb spellings; none found.
 *  - Right of `there`: unanchored, "landed there" also matches inside "landed therefore" — the
 *    document carries `therefore`/`thereafter`/`thereby` as standalone words (swept via
 *    `\bthere[a-z]+`), none currently adjacent to a locked verb, but the class is live — this is
 *    the exact shape hit once in this document's own drafting and caught only by rewriting the
 *    sentence, not by the pattern.
 *  - Left of `the` on the second alternative: unanchored, "breathe deeply above" supplies a
 *    phantom "the" from inside "breathe" — swept via `/([a-zA-Z])the [a-z]+ above/`, none found.
 *  - Right of `above`: unanchored, would match inside "abovementioned" — swept via
 *    `/the [a-z]+ above([a-zA-Z])/`, none found.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: the positional sweep's own pattern
 * (`the ([a-z]+ ){1,4}(above|below)`, deferredWorkPositionalSweep.ts) has the identical class of
 * gap on its own `the`/`above|below` edges — noticed while sweeping this one, not fixed here.
 * Widening scope to a second stored instrument belongs to its own establish pass; recorded in
 * docs/deferred-work.md item 257 as a finding for a future one, not a silent extension of this
 * fix.
 */
export function buildAnaphorPattern(): RegExp {
  const verbAlternation = ANAPHOR_VERBS.join("|");
  return new RegExp(`\\b(${verbAlternation}) there\\b|\\bthe [a-z]+ above\\b`, "g");
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
