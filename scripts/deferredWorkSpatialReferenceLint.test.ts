import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { findSpatialReferences, toAllowedPairs } from "./deferredWorkSpatialReferenceLint.js";

/**
 * Item 302's own verification. This is the check itself, not a probe of the
 * ledger's content — see deferredWorkSpatialReferenceLint.ts for the design
 * rationale (allowlist keyed on (item, text), not text alone; the scan
 * boundary at "## Status snapshot") and item 302 in docs/deferred-work.md
 * for the ledger record of why this exists, including the boundary bug this
 * entry's own establish work produced and corrected in the same pass.
 */

const LEDGER_PATH = path.join(process.cwd(), "docs", "deferred-work.md");

/**
 * Frozen baseline as of the commit that introduced this lint — every pair
 * here is pre-existing text, allowlisted in bulk rather than individually
 * rewritten (see this file's own module doc for the disposition rule). Items
 * 302 and 303 (this lint's own ledger entries) deliberately introduce none —
 * an earlier draft quoted historical spatial-reference examples verbatim and
 * tripped the pre-existing, unrelated anaphor/positional sweeps' own frozen
 * absolutes (ANAPHOR_ABSOLUTE, POSITIONAL_*_ABSOLUTE), which have no
 * allowlist mechanism at all; the fix was to name the referenced items
 * instead of quoting the phrases, not to special-case the quotes here.
 * Regenerate ONLY by re-running findSpatialReferences over a deliberately
 * reviewed diff, never by pasting a failure's "actual" output back in here —
 * that would make the assertion below decorative.
 */
const SPATIAL_REFERENCE_ALLOWLIST: ReadonlyArray<{ item: number | null; text: string }> = [
  { item: 2, text: "the imbalance counter above" },
  { item: 11, text: "the markers described above" },
  { item: 12, text: "landed there" },
  { item: 12, text: "the two call sites above" },
  { item: 12, text: "the anomaly branch the hazard above" },
  { item: 14, text: "the original text above" },
  { item: 16, text: "the repair below" },
  { item: 18, text: "the pass below" },
  { item: 18, text: "the pass described below" },
  { item: 18, text: "the two equality comparisons named above" },
  { item: 18, text: "the corrections above" },
  { item: 23, text: "the one above" },
  { item: 23, text: "the recipe below" },
  { item: 23, text: "the count above" },
  { item: 36, text: "the headings above" },
  { item: 36, text: "the check by name below" },
  { item: 36, text: "the residue of the paragraph above" },
  { item: 38, text: "the tradeoff above" },
  { item: 54, text: "the header comment above" },
  { item: 56, text: "corrected there" },
  { item: 56, text: "the fix below" },
  { item: 56, text: "the fix reasoning below" },
  { item: 56, text: "the five affected files above" },
  { item: 56, text: "the file above" },
  { item: 61, text: "the field the bullet above" },
  { item: 63, text: "the threshold above" },
  { item: 65, text: "the two above" },
  { item: 65, text: "the table above" },
  { item: 65, text: "the two above" },
  { item: 73, text: "the numbers below" },
  { item: 74, text: "the two are separated below" },
  { item: 74, text: "the prefix problem above" },
  { item: 74, text: "the counts above" },
  { item: 76, text: "the reasons above" },
  { item: 78, text: "the paragraph above" },
  { item: 78, text: "the distribution below" },
  { item: 78, text: "the population above" },
  { item: 78, text: "the caution above" },
  { item: 78, text: "the same figure recorded above" },
  { item: 78, text: "the half below" },
  { item: 78, text: "the figures above" },
  { item: 79, text: "the answer is recorded below" },
  { item: 79, text: "the one the run below" },
  { item: 79, text: "the delivered extras fall below" },
  { item: 79, text: "the average above" },
  { item: 79, text: "the sentence above" },
  { item: 79, text: "the sentence above" },
  { item: 79, text: "the mechanisms above" },
  { item: 79, text: "the measured inertness above" },
  { item: 79, text: "the paragraph above" },
  { item: 79, text: "the transcript above" },
  { item: 79, text: "the two runs above" },
  { item: 79, text: "the caps paragraph above" },
  { item: 79, text: "the strand below" },
  { item: 79, text: "the branch above" },
  { item: 79, text: "the pair above" },
  { item: 79, text: "the block below" },
  { item: 79, text: "the gate sits above" },
  { item: 79, text: "the path above" },
  { item: 79, text: "the paragraphs above" },
  { item: 79, text: "the strand above" },
  { item: 79, text: "the sentence above" },
  { item: 79, text: "the same value the strand above" },
  { item: 79, text: "the strand above" },
  { item: 79, text: "the paragraph above" },
  { item: 79, text: "the paragraphs above" },
  { item: 79, text: "the fourth dependency above" },
  { item: 79, text: "the ordering finding above" },
  { item: 79, text: "the two above" },
  { item: 79, text: "the eight findings above" },
  { item: 79, text: "the pool below" },
  { item: 90, text: "the outcome paragraphs below" },
  { item: 90, text: "the three named above" },
  { item: 94, text: "the essay decision below" },
  { item: 100, text: "the first two mistakes above" },
  { item: 101, text: "the pair and configuration figures above" },
  { item: 110, text: "the tier subset below" },
  { item: 111, text: "the removal record below" },
  { item: 113, text: "the comment sits directly above" },
  { item: 120, text: "the current absence are confirmed above" },
  { item: 129, text: "the scoping specified above" },
  { item: 151, text: "the rate from below" },
  { item: 153, text: "the rate from below" },
  { item: 165, text: "the false alternation described above" },
  { item: 166, text: "the retirement below" },
  { item: 176, text: "the three locks below" },
  { item: 177, text: "the offered set false below" },
  { item: 182, text: "the fix below" },
  { item: 184, text: "the check below" },
  { item: 189, text: "the fix the bucket note below" },
  { item: 193, text: "the current text below" },
  { item: 218, text: "the seven below" },
  { item: 223, text: "the frozen snapshot below" },
  { item: 248, text: "the reason stated above" },
  { item: 250, text: "the normal approximation above" },
];

describe("deferred-work spatial-reference lint", () => {
  it("PLAUSIBILITY FLOOR: the ledger is read and is not trivially short", () => {
    const text = fs.readFileSync(LEDGER_PATH, "utf8");
    expect(text.length).toBeGreaterThan(100_000);
    expect(text.split("\n").length).toBeGreaterThan(1000);
  });

  it("the full (item, text) match sequence equals the frozen allowlist exactly", () => {
    const text = fs.readFileSync(LEDGER_PATH, "utf8");
    const matches = findSpatialReferences(text);
    expect(toAllowedPairs(matches)).toEqual(SPATIAL_REFERENCE_ALLOWLIST);
  });

  it("HOSTILE INPUT: a synthetic entry with an un-referented spatial pointer is detected", () => {
    const synthetic = [
      "## 9001. A synthetic entry for the lint's own test",
      "",
      "This sentence points at the finding above without naming it, which is exactly",
      "the shape this lint exists to catch.",
      "",
    ].join("\n");
    const matches = findSpatialReferences(synthetic);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.text.includes("above"))).toBe(true);
    expect(matches[0]!.item).toBe(9001);
  });

  it("a synthetic entry naming its referent explicitly is not flagged", () => {
    const synthetic = [
      "## 9002. A synthetic entry for the lint's own test",
      "",
      "This sentence points at item 9001's finding by number, which is the fix",
      "this lint expects instead of a spatial pointer.",
      "",
    ].join("\n");
    expect(findSpatialReferences(synthetic)).toEqual([]);
  });

  it("a below-direction hit is detected, not just above (Y1 regression pin)", () => {
    const synthetic = [
      "## 9003. A synthetic entry for the lint's own test",
      "",
      "See the corrected figure below for the real count.",
      "",
    ].join("\n");
    const matches = findSpatialReferences(synthetic);
    expect(matches.some((m) => m.text.includes("below"))).toBe(true);
  });

  it("a verb+there hit is detected via the anaphor pattern, not just the positional above/below shape", () => {
    const synthetic = [
      "## 9004. A synthetic entry for the lint's own test",
      "",
      "The defect was fixed there, in the same paragraph, without naming what fixed it.",
      "",
    ].join("\n");
    const matches = findSpatialReferences(synthetic);
    expect(matches.some((m) => m.text.includes("there"))).toBe(true);
  });

  it("every match in the real ledger resolves to an enclosing item — zero orphans (AA1b regression pin)", () => {
    const text = fs.readFileSync(LEDGER_PATH, "utf8");
    const matches = findSpatialReferences(text);
    const orphans = matches.filter((m) => m.item === null);
    expect(orphans).toEqual([]);
  });

  it("content after a synthetic Status snapshot heading is excluded from the scan, not folded into the preceding item (itemForLine boundary regression pin)", () => {
    // This is the shape of the defect item 302's own establish work produced: without
    // a scan boundary, "the finding above" here would have matched and been credited
    // to item 9005 — the last numbered heading before it — even though it is no part
    // of that entry's body. The fix excludes it entirely rather than attributing it
    // anywhere, matching how the real ledger's Status snapshot section and the
    // "pattern" essays after it are excluded.
    const synthetic = [
      "## 9005. A synthetic entry for the lint's own test",
      "",
      "This sentence names item 9005 explicitly and is not flagged.",
      "",
      "## Status snapshot",
      "",
      "This sentence points at the finding above without naming it, mimicking free-form",
      "prose that follows the numbered items and is not itself a ledger entry.",
      "",
    ].join("\n");
    const matches = findSpatialReferences(synthetic);
    expect(matches).toEqual([]);
  });
});
