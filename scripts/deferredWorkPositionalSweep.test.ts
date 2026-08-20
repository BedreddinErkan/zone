/**
 * Checks docs/deferred-work.md's positional-reference sweep against the pattern stored in
 * deferredWorkPositionalSweep.ts. Commit 32aa25d2 named this concept and could not verify a
 * recorded "46" against it — this file is what makes 112/126 the first true recorded absolutes
 * for it, not a reconciliation against that prior, unfound number.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  POSITIONAL_LINE_BASED_ABSOLUTE,
  POSITIONAL_WRAP_NORMALIZED_ABSOLUTE,
  buildPositionalPattern,
  countLineBased,
  countWrapNormalized,
  sweep,
} from "./deferredWorkPositionalSweep.js";

const LEDGER_PATH = path.join(process.cwd(), "docs", "deferred-work.md");

describe("docs/deferred-work.md positional-reference sweep", () => {
  const text = fs.readFileSync(LEDGER_PATH, "utf8");
  const result = sweep(text);

  // Deliberately two tests here, not three like the anaphor sweep's sibling file: there is no
  // third "the gap must be X" assertion, because asserting a specific gap (zero OR nonzero)
  // would be exactly the false agreement/disagreement this module's own doc comment argues
  // against. Each instrument is pinned independently; their relationship is not.

  it("the line-based count matches the recorded absolute", () => {
    expect(
      result.lineBased,
      `line-based count is ${result.lineBased}, expected the recorded absolute ${POSITIONAL_LINE_BASED_ABSOLUTE}`
    ).toBe(POSITIONAL_LINE_BASED_ABSOLUTE);
  });

  it("the wrap-normalized count matches the recorded absolute", () => {
    expect(
      result.wrapNormalized,
      `wrap-normalized count is ${result.wrapNormalized}, expected the recorded absolute ${POSITIONAL_WRAP_NORMALIZED_ABSOLUTE}`
    ).toBe(POSITIONAL_WRAP_NORMALIZED_ABSOLUTE);
  });
});

describe("fixture-driven: known shapes", () => {
  it("a clean, same-line, two-word-gap instance is detected by both instruments", () => {
    const fixture = "Nothing new here -- the paragraph just above already covers it.";
    expect(countLineBased(fixture)).toBe(1);
    expect(countWrapNormalized(fixture)).toBe(1);
  });

  it("no positional referent in the text -- both instruments return zero", () => {
    const fixture = "Nothing here points at anything by position. The fix stands on its own.";
    expect(countLineBased(fixture)).toBe(0);
    expect(countWrapNormalized(fixture)).toBe(0);
  });

  // Same shape as the anaphor sweep's own wrap-broken fixture (item 126/180).
  it("a referent broken across a wrap: line-based misses it, wrap-normalized catches it", () => {
    const fixture = "This restates the summary strand\nabove, which nothing else here explains.";
    const result = sweep(fixture);
    expect(result.lineBased, "line-based must miss a referent split across a wrap").toBe(0);
    expect(result.wrapNormalized, "wrap-normalized must catch the same referent").toBe(1);
  });
});

describe("fixture-driven: the {1,4} bound is a named boundary, not an accident", () => {
  it("a 4-word gap is inside the bound", () => {
    const fixture = "as covered in the paragraph just cited right above, nothing more to add";
    expect(countLineBased(fixture)).toBe(1);
  });

  it("the same construction with one more intervening word is deliberately outside the bound", () => {
    const fixture = "the paragraph that was just cited above explains it fully";
    expect(countLineBased(fixture)).toBe(0);
  });

  it("dropping 'below' from the alternation would be a real, silent narrowing -- both words are live", () => {
    const fixture = "the note below explains it";
    expect(countLineBased(fixture)).toBe(1);
  });

  it("capitalized 'The' is a deliberate exclusion, not a silent gap -- same sentence, only case differs", () => {
    const lower = "Unrelated setup text. Then it restores the version above, unchanged.";
    const upperAtSentenceStart = "Unrelated setup text. The version above is unchanged.";
    expect(countLineBased(lower)).toBe(1);
    expect(countLineBased(upperAtSentenceStart)).toBe(0);
  });

  it("a known false-positive idiom shape is counted, not filtered -- no denylist exists", () => {
    const fixture = "the added cost is bounded above by its own measured runtime.";
    expect(countLineBased(fixture)).toBe(1);
  });

  // The defect shape named in buildPositionalPattern's own doc comment, constructed minimally
  // rather than relying on the real document's 119-vs-112 disagreement to prove it. Two
  // candidate windows exist in this string ("the value ... above" as a 4-word match, "the model
  // saw above" as a 2-word match); the combined {1,4} pattern's greedy non-overlapping scan
  // finds exactly one.
  it("summing per-length matches is not the same instrument as the combined {1,4} pattern", () => {
    const fixture = "the value the model saw above";
    const combined = (fixture.match(buildPositionalPattern()) ?? []).length;
    const length2 = (fixture.match(/the ([a-z]+ ){2}(above|below)/g) ?? []).length;
    const length4 = (fixture.match(/the ([a-z]+ ){4}(above|below)/g) ?? []).length;
    expect(combined).toBe(1);
    expect(
      length2 + length4,
      "the sum of independently-tested per-length matches is a different count from the combined pattern's own scan"
    ).toBe(2);
    expect(combined).not.toBe(length2 + length4);
  });
});

/**
 * Seven candidate patterns a prior pass tried while chasing the unfound "46" (commit
 * 32aa25d2): (1) `(above|below)` — 324; (2) `the [a-z]+ (above|below)` — 65; (3) `[a-z]+ below`
 * — 95; (4) `(entry|item|section) (above|below)` — 0; (5)
 * `(shown|listed|named|described|quoted) (above|below)` — 11; (6) `(see|per) (above|below)` —
 * 3; (7) `the [a-z]+ above` — 49. Full counts and per-candidate discussion live in the pass
 * report and this module's own header comment, not duplicated here.
 *
 * Only three of the seven express a genuine, corpus-independent STRUCTURAL relationship to the
 * stored pattern — a relationship that holds by construction, not by a raw count that drifts
 * every time the document grows. Those three are pinned below, by match-SPAN coverage (not by
 * count — raw-count subset reasoning is unsound here, see buildPositionalPattern's own
 * non-overlapping-match doc comment). Pinning all seven exact counts as permanent assertions
 * would mean every future change to the stored pattern — or every paragraph the document ever
 * grows by — has to update seven coverage assertions that express no boundary of THIS pattern;
 * that is not done here.
 *
 * Candidates 3, 5, and 6 have no "the" anchor at all and so can catch real content the stored
 * pattern structurally excludes by design (a deliberate exclusion — see
 * buildPositionalPattern's own doc comment on why anchoring on "the" is the right trade). That
 * is illustrated with one small fixture below, not tracked as a live count against the real
 * document.
 *
 * Candidate 4 is vacuous on this corpus (0 matches) — not a meaningful comparison point, and
 * asserted as exactly that below rather than silently omitted.
 */
describe("prior candidate patterns vs. the stored {1,4} pattern — structural relationships only", () => {
  const text = fs.readFileSync(LEDGER_PATH, "utf8");

  function matches(re: RegExp): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    const r = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = r.exec(text))) out.push({ start: m.index, end: m.index + m[0].length });
    return out;
  }

  const stored = matches(buildPositionalPattern());

  it("candidate 1 `(above|below)` is a strict superset -- every stored match's span contains a candidate-1 hit", () => {
    const cand1 = matches(/(above|below)/);
    const uncovered = stored.filter(
      (s) => !cand1.some((c) => c.start >= s.start && c.end <= s.end)
    );
    expect(uncovered, "every stored match must contain at least one bare above/below").toEqual([]);
  });

  it("candidate 2 `the [a-z]+ (above|below)` is a strict subset by coverage -- the one-word case the stored pattern widens", () => {
    const cand2 = matches(/the [a-z]+ (above|below)/);
    const uncovered = cand2.filter(
      (c) => !stored.some((s) => s.start <= c.start && s.end >= c.end)
    );
    // Not always at an identical start position -- some candidate-2 matches are absorbed into
    // a longer stored match (e.g. a real "the anomaly branch the hazard above" absorbs the
    // shorter "the hazard above") rather than corresponding to their own stored match at the
    // same start. Still fully covered by span, not missed.
    expect(uncovered, "every candidate-2 match must be covered by some stored match's span").toEqual([]);
  });

  it("candidate 7 `the [a-z]+ above` is a strict subset by coverage -- the anaphor sweep's own existing 'above' arm", () => {
    const cand7 = matches(/the [a-z]+ above/);
    const uncovered = cand7.filter(
      (c) => !stored.some((s) => s.start <= c.start && s.end >= c.end)
    );
    expect(uncovered).toEqual([]);
  });

  it("candidates 3/5/6 have no 'the' anchor -- a deliberate, illustrated exclusion, not a live-tracked count", () => {
    const noAnchorExample = "Changes are listed below:";
    expect(countLineBased(noAnchorExample)).toBe(0);
    expect((noAnchorExample.match(/[a-z]+ below/g) ?? []).length).toBe(1); // candidate 3
    expect(
      (noAnchorExample.match(/(shown|listed|named|described|quoted) (above|below)/g) ?? []).length
    ).toBe(1); // candidate 5
    const seePerExample = "Nothing new here, see above for the full account.";
    expect(countLineBased(seePerExample)).toBe(0);
    expect((seePerExample.match(/(see|per) (above|below)/g) ?? []).length).toBe(1); // candidate 6
  });

  it("candidate 4 `(entry|item|section) (above|below)` is vacuous on this corpus -- asserted as vacuous, not silently dropped", () => {
    const cand4 = matches(/(entry|item|section) (above|below)/);
    expect(cand4.length, "candidate 4 is a known-vacuous comparison point on this corpus").toBe(0);
  });
});
