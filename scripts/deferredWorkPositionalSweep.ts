/**
 * The single source of truth for docs/deferred-work.md's positional-reference sweep. Commit
 * 32aa25d2 named this concept and could not verify it against a recorded "46": seven candidate
 * patterns gave 49/16/95/11/3/65/324, none reproduced 46, and the pattern that would produce it
 * "is not stored anywhere." A repository-and-git-history-wide search found no record of 46 in
 * this role anywhere — there is nothing to retract from any ledger entry. This module
 * establishes the first true stored value, the same way deferredWorkAnaphorSweep.ts did for
 * item 126's convention.
 *
 * Standing rule, mirroring the anaphor sweep's own discipline for its locked absolute: if
 * POSITIONAL_LINE_BASED_ABSOLUTE or POSITIONAL_WRAP_NORMALIZED_ABSOLUTE ever drifts from what
 * `npm test` reports, scan the drifting pass's OWN added lines first — in eight of nine passes
 * across this document's history, the surplus that broke a locked count was the pass itself,
 * not a prior error. This module's own two absolutes were deliberately measured and locked
 * AFTER every other edit this same pass made to the ledger, for exactly that reason: a pass
 * that adds prose describing this sweep is itself a source of "the X above/below" text, and
 * measuring before the pass's own prose landed would have locked a number the pass's own
 * commit immediately invalidated.
 *
 * Operates on a string, not a file path — the ledger path lives in the test that calls this.
 */

/**
 * `the ([a-z]+ ){MIN,MAX}(above|below)` — lowercase `the` only, mirroring the anaphor sweep's
 * own lowercase-only convention. Capitalized `The (...) (above|below)` occurs 26 times in this
 * document (at the commit these absolutes were locked) and is deliberately excluded: a named
 * boundary, not a silent gap.
 *
 * Requiring `the` to directly open the match — never scanning backward from `above`/`below` —
 * already rules out this document's single most common non-referential idiom shape for free:
 * "above the cap", "below a floor" put the comparison word BEFORE `the`, so they cannot match
 * this shape at all. The remaining false-positive risk is narrower: the `the ... above/below`
 * shape where the intervening span happens to contain a numeric/mathematical-bound idiom rather
 * than a genuine cross-reference — see POSITIONAL_LINE_BASED_ABSOLUTE.
 */
export const POSITIONAL_MIN_WORDS = 1;

/**
 * Chosen deliberately, not exhaustively. {1} alone is the anaphor sweep's own existing "above"
 * arm; widening to 4 closes the two/three/four-word cases with headroom. Widening further stops
 * paying for itself: at 5+ words, candidate windows start gluing unrelated clauses across
 * `the`-boundaries (e.g. "the two tasks well above the cap", "the added cost is bounded above by
 * its own measured runtime" — both mathematical-bound idioms, not document references, and both
 * only reachable at wider windows than this one).
 */
export const POSITIONAL_MAX_WORDS = 4;

/**
 * Line-based count, locked AFTER every other ledger edit this pass made (see this module's own
 * header comment on why). Confirmed by three independent instruments in agreement — Node's
 * RegExp (this module's own method), `command grep -E -o | wc -l`, and `git grep -E -o -h` — all
 * three returned the identical number against the same commit. POSIX ERE (leftmost-longest) and
 * JS RegExp (leftmost-first with backtracking) CAN diverge on a shape like this one; here they
 * did not, which is itself the finding, not a formality assumed in advance.
 *
 * Includes 2 known false positives, both the identical recurring idiom "the rate from below"
 * (e.g. "...a clean sweep bounds the rate from below and never means..." — a
 * statistical/binomial-bound phrase, not a document cross-reference). Not filtered out of this
 * absolute — see sweep()'s own doc comment for why no denylist exists.
 *
 * Re-locked from 112 to 114 by the apply_patch silent-gates pass (items 245-250): two new
 * same-item backward references, "the reason stated above" (item 248) and "the normal
 * approximation above" (item 250), each pointing at the immediately preceding paragraph within
 * its own entry. Checked individually before re-locking, per this module's own header comment —
 * both have a clear, close antecedent and are not the shape this sweep exists to flag. Confirmed
 * by the same three independent instruments as the original lock: Node RegExp, `grep -E -o`, and
 * `git grep -E -o -h` all returned 114 against the same commit.
 *
 * Re-verified unchanged at 114 after buildPositionalPattern gained \b anchors on both open edges
 * (ledger item 257) — by span-diff (start index + matched text), not count alone: old and new
 * patterns produced byte-identical 114-element span lists on the live document, zero removed,
 * zero added. Cross-checked on the HARDENED pattern by the same three instruments as every prior
 * lock — Node, `command grep -E -o`, `git grep -E -o -h` — all three still agree at 114; the
 * POSIX-ERE-vs-JS divergence risk `\b` on a `{1,4}` group raises did not materialise.
 */
export const POSITIONAL_LINE_BASED_ABSOLUTE = 114;

/**
 * Wrap-normalized count, same commit. NOT required to equal the line-based figure — see
 * sweep()'s doc comment. Locked independently so a silent drift in either instrument, not just
 * their difference, is caught.
 *
 * Confirmed by three instruments, the same evidence the line-based absolute carries, and for the
 * same reason: a figure derived once by one engine is one instrument, not two, however many ways
 * it is printed. The paragraph-join transform is the obstacle to cross-checking rather than the
 * count, so it was reproduced outside Node twice — `awk 'BEGIN{RS=""}' + gsub` piped to
 * `command grep -E -o`, and `perl -00 -pe 's/\n/ /g'` piped to the same — and both agree with
 * this module's own JS matcher exactly. Two of the three share no regex engine with it, so
 * POSIX-ERE-vs-JS divergence on `([a-z]+ ){1,4}` followed by an alternation, which is a real
 * possibility for this shape, is ruled out by measurement rather than assumed away.
 *
 * Re-locked from 126 to 128 alongside the line-based absolute above — see its own comment for
 * the two new references. Confirmed by the same paragraph-join cross-check as the original lock:
 * `awk 'BEGIN{RS=""}' + gsub` piped to `grep -E -o`, and `perl -00 -pe 's/\n/ /g'` piped to the
 * same, both agree with this module's own JS matcher at 128.
 *
 * Re-verified unchanged at 128 after the same \b hardening (item 257), by the identical
 * span-diff discipline (per-paragraph spans, not just the total) and the same two outside-Node
 * cross-checks re-run against the hardened pattern — both still agree at 128.
 */
export const POSITIONAL_WRAP_NORMALIZED_ABSOLUTE = 128;

/**
 * Built from POSITIONAL_MIN_WORDS/POSITIONAL_MAX_WORDS. Every alternative uses a literal space,
 * never `\s` — same guarantee as buildAnaphorPattern: a global match on the raw string cannot
 * cross a line boundary, so countLineBased is correct without splitting the input first.
 *
 * Non-overlapping match semantics are load-bearing here in a way they are not for the anaphor
 * sweep's single-token pattern: summing counts from testing each intervening-word-length (1, 2,
 * 3, 4) independently gives 65+32+14+8 = 119 on the real document; this pattern's actual count is
 * 112. A recurring "the" can be matched from either of two starting points at different lengths
 * when tested in isolation, but one global {1,4} regex produces one greedy match per region and
 * continues scanning after it — it does not re-test the positions its own match consumed. Do not
 * "verify" this pattern by summing per-length counts; that sum is a different instrument, not
 * this one, by construction. (Confirmed with a minimal fixture in the test file — see the test
 * named for exactly this shape.)
 *
 * WHAT THIS COVERS: two word-boundary-anchored edges — `\bthe` and `(above|below)\b` — enumerated
 * by walking every zero-width position in the pattern, not guessed by analogy to the anaphor
 * pattern. Only two, not four like that pattern's own two-alternative construction, because this
 * is one alternative: every position between `the` and the closing group is already bounded by a
 * mandatory literal space (see the paragraph above). Each `\b` closes a real, swept gap, checked
 * on the live document rather than assumed clean by construction:
 *  - Left of `the`: unanchored, a word ending in "the" ("breathe") directly preceding a
 *    legitimate word-run and `above`/`below` supplies a phantom match — swept via
 *    `/([a-zA-Z])the ([a-z]+ ){1,4}(above|below)/g`, zero live instances.
 *  - Right of `(above|below)`: unanchored, matches as a prefix of a longer word
 *    ("abovementioned", "belowground") — swept via
 *    `/the ([a-z]+ ){1,4}(above|below)([a-zA-Z])/g`, zero live instances. One anchor guards both
 *    alternation members at once, since they share the same closing position.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: capitalized `The`, already a named exclusion above, not
 * reopened by this hardening; any additional false-positive filtering for the two known "the rate
 * from below" idiom matches — sweep()'s own doc comment already declines a denylist and this
 * change does not revisit that.
 */
export function buildPositionalPattern(): RegExp {
  return new RegExp(
    `\\bthe ([a-z]+ ){${POSITIONAL_MIN_WORDS},${POSITIONAL_MAX_WORDS}}(above|below)\\b`,
    "g"
  );
}

/** Matches within a line by construction (see buildPositionalPattern's comment) — mirrors
 *  `command grep -E -o` / `git grep -E -o -h` counting non-overlapping matches. Confirmed, not
 *  merely asserted: all three instruments agree exactly at commit-time (see
 *  POSITIONAL_LINE_BASED_ABSOLUTE's own doc comment). */
export function countLineBased(text: string): number {
  return (text.match(buildPositionalPattern()) ?? []).length;
}

/**
 * Paragraph-join instrument, same mechanism as the anaphor sweep's own amendment: splits on
 * blank-line boundaries, joins each paragraph's internal newlines with a space, counts per
 * paragraph. Collapsing is scoped to one paragraph so it cannot manufacture a match across two.
 */
export function countWrapNormalized(text: string): number {
  const paragraphs = text.split(/\n\s*\n/);
  const pattern = buildPositionalPattern();
  let total = 0;
  for (const paragraph of paragraphs) {
    const joined = paragraph.replace(/\n/g, " ");
    total += (joined.match(pattern) ?? []).length;
  }
  return total;
}

export interface PositionalSweepResult {
  lineBased: number;
  wrapNormalized: number;
  gap: number;
}

/**
 * Convenience wrapper — what a ledger pass should call instead of writing either counter by hand
 * again.
 *
 * Why no gap requirement, unlike the anaphor sweep's ANAPHOR_GAP_REQUIREMENT = 0: that invariant
 * holds because, empirically, no single-word anaphor in this document currently straddles a wrap,
 * so agreement is a meaningful "nothing is hidden" signal. This wider, multi-word pattern
 * disagrees by 14 (112 vs 126) for a structural reason, not an anomaly: wider windows are
 * simultaneously more likely to catch a genuinely wrapped referent and more likely to glue
 * unrelated clauses across a wrap boundary — confirmed directly: two of the wrap-only matches at
 * lock time were real ("the two tasks well above [the cap]", "the added cost is bounded above
 * [by its own measured runtime]" — the same mathematical-bound idiom class the line-based
 * absolute already carries two instances of). Forcing equality here would either hide real
 * wrapped referents (trusting only the line-based count) or silently absorb false positives
 * (trusting the wrap-normalized count blindly). Both absolutes are locked independently instead
 * — gap is exposed on the result for diagnostics, not asserted against.
 *
 * Why no denylist for the 2 known line-based false positives ("the rate from below" x2): the
 * anaphor sweep's own precedent (item 126) accepts that its matcher "counts mentions alongside
 * uses" as a documented limitation rather than building an exclusion list. Same choice here — a
 * growing denylist is unauditable and fragile in a way a documented, quoted false positive is
 * not.
 */
export function sweep(text: string): PositionalSweepResult {
  const lineBased = countLineBased(text);
  const wrapNormalized = countWrapNormalized(text);
  return { lineBased, wrapNormalized, gap: wrapNormalized - lineBased };
}
