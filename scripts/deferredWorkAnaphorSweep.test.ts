/**
 * Checks docs/deferred-work.md's anaphor sweep (item 126) against the pattern stored in
 * deferredWorkAnaphorSweep.ts, so the recorded absolute (52) is enforced from an artifact
 * rather than re-derived by each ledger pass and validated circularly against itself.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANAPHOR_ABSOLUTE,
  ANAPHOR_GAP_REQUIREMENT,
  countLineBased,
  countWrapNormalized,
  sweep,
} from "./deferredWorkAnaphorSweep.js";

const LEDGER_PATH = path.join(process.cwd(), "docs", "deferred-work.md");

describe("docs/deferred-work.md anaphor sweep (item 126)", () => {
  const text = fs.readFileSync(LEDGER_PATH, "utf8");
  const result = sweep(text);

  it("the line-based count matches the recorded absolute", () => {
    expect(
      result.lineBased,
      `line-based count is ${result.lineBased}, expected the recorded absolute ${ANAPHOR_ABSOLUTE}`
    ).toBe(ANAPHOR_ABSOLUTE);
  });

  it("the wrap-normalized count matches the recorded absolute", () => {
    expect(
      result.wrapNormalized,
      `wrap-normalized count is ${result.wrapNormalized}, expected the recorded absolute ${ANAPHOR_ABSOLUTE}`
    ).toBe(ANAPHOR_ABSOLUTE);
  });

  it("the two instruments agree — a nonzero gap means a referent is hidden by a wrap", () => {
    expect(
      result.gap,
      `line-based=${result.lineBased}, wrap-normalized=${result.wrapNormalized} — ` +
        `a nonzero gap means a referent is hidden by a soft wrap, not that the absolute moved`
    ).toBe(ANAPHOR_GAP_REQUIREMENT);
  });
});

describe("fixture-driven: known shapes", () => {
  it("a clean, same-line instance is detected by both instruments", () => {
    const fixture = "The bug was fixed there, in the same commit that introduced it.";
    expect(countLineBased(fixture)).toBe(1);
    expect(countWrapNormalized(fixture)).toBe(1);
  });

  it("no anaphor in the text — both instruments return zero", () => {
    const fixture = "Nothing here points at anything by position. The fix stands on its own.";
    expect(countLineBased(fixture)).toBe(0);
    expect(countWrapNormalized(fixture)).toBe(0);
  });

  // Reproduces item 126's own documented failure shape: a referent whose words fall either
  // side of a soft wrap, inside one paragraph (no blank line), so a line-based matcher cannot
  // see it but the paragraph-join instrument can — the disagreement itself is the signal.
  it("a referent broken across a wrap: line-based misses it, wrap-normalized catches it, and the gap is reported rather than silently agreeing at zero", () => {
    const fixture = "The fix restored the promise\nabove, which nothing else in this paragraph names.";
    const result = sweep(fixture);
    expect(result.lineBased, "line-based must miss a referent split across a wrap").toBe(0);
    expect(result.wrapNormalized, "wrap-normalized must catch the same referent").toBe(1);
    expect(result.gap, "the divergence is the finding — it must not be zero here").not.toBe(0);
  });
});

/**
 * One fixture per boundary edge buildAnaphorPattern's own comment names, each pinning a
 * regression this document itself hit once ("landed there" also matching inside "landed
 * therefore" — the exact shape of the second fixture below) rather than a hypothetical.
 */
describe("fixture-driven: the four word-boundary edges are real boundaries, not accidents", () => {
  it("left of the verb group: 'closed' inside 'disclosed' does not count as the anaphor", () => {
    const fixture = "The finding was disclosed there, in the same paragraph.";
    expect(countLineBased(fixture)).toBe(0);
    expect(countWrapNormalized(fixture)).toBe(0);
  });

  it("right of 'there': 'landed there' does not also match inside 'landed therefore' — this document's own drafting hit this once", () => {
    const fixture = "Only the first change landed therefore the second needed its own fix.";
    expect(countLineBased(fixture)).toBe(0);
    expect(countWrapNormalized(fixture)).toBe(0);
  });

  it("left of 'the' on the above arm: a word ending in 'the' does not supply a phantom referent", () => {
    const fixture = "Please breathe deeply above the noise before deciding.";
    expect(countLineBased(fixture)).toBe(0);
    expect(countWrapNormalized(fixture)).toBe(0);
  });

  it("right of 'above': 'the item above' does not also match inside 'the item abovementioned'", () => {
    const fixture = "See the item abovementioned for the full argument.";
    expect(countLineBased(fixture)).toBe(0);
    expect(countWrapNormalized(fixture)).toBe(0);
  });

  it("the boundaries narrow false positives without narrowing real matches — the original three fixtures still count", () => {
    // Guards the guard the other direction: \b additions that are too aggressive
    // (e.g. requiring a boundary INSIDE "there" itself) would silently zero out
    // the legitimate cases above, and every existing test in this file would
    // still need to keep passing for that regression to be caught here too.
    expect(countLineBased("The bug was fixed there, in the same commit that introduced it.")).toBe(1);
    expect(countLineBased("the anomaly branch the hazard above would drive every downstream check.")).toBe(1);
  });
});
