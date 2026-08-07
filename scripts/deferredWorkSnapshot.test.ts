/**
 * Ledger item 36 — mechanically checks docs/deferred-work.md's status snapshot against the
 * ledger's own `## N.` headings. Item 36 itself proposed only the Closed-set comparison
 * (assertion 2 below); the historical failure it was actually caught by (item 36 having a
 * heading but appearing in no bucket, at commit 9f45989c) is a coverage defect, which only
 * assertions 3 and 4 catch. Section-scoped to the snapshot block deliberately: a whole-file
 * paragraph scan is not required by anything in the document today, but a bold-led paragraph
 * with a parenthesized count elsewhere in this dense a document is not implausible in the
 * future, and scoping costs nothing to keep.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LEDGER_PATH = path.join(process.cwd(), "docs", "deferred-work.md");

interface Heading {
  n: number;
  closed: boolean;
}

interface Bucket {
  label: string;
  declared: number;
  items: number[];
}

function parseHeadings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  for (const line of lines) {
    const m = /^## (\d+)\. (.*)$/.exec(line);
    if (m) out.push({ n: Number(m[1]), closed: /^Closed —/.test(m[2]!) });
  }
  return out;
}

function parseSnapshotBuckets(lines: string[]): Bucket[] {
  const start = lines.findIndex((l) => /^## Status snapshot/.test(l));
  if (start === -1) {
    throw new Error("No '## Status snapshot' heading found in docs/deferred-work.md.");
  }
  let end = start + 1;
  while (end < lines.length && !/^---$/.test(lines[end]!)) end++;
  const section = lines.slice(start, end);

  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of section) {
    if (line.trim() === "") {
      if (current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current.join(" "));

  // Trailing capture is `.*`, not `.+`: a bucket can legitimately be empty (e.g. "(0):"
  // with nothing after the colon, the natural minimal edit when its last item is
  // removed by hand). With `.+` that paragraph failed to match at all and the whole
  // bucket silently vanished from the parsed set — see docs/deferred-work.md item 36.
  const bucketRe = /^\*\*(.+?)\*\*.*?\((\d+)\):\s*(.*)$/;
  const buckets: Bucket[] = [];
  for (const p of paragraphs) {
    const m = bucketRe.exec(p);
    if (!m) continue;
    const label = m[1]!.split(" —")[0]!.trim();
    const declared = Number(m[2]);
    const items = m[3]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const mm = /^(\d+)/.exec(s);
        if (!mm) {
          throw new Error(`Unparseable item entry in bucket "${label}": ${JSON.stringify(s)}`);
        }
        return Number(mm[1]);
      });
    buckets.push({ label, declared, items });
  }
  return buckets;
}

const REQUIRED_BUCKETS = ["Closed", "Actionable now", "Blocked on data", "Neither"];

/** Names which of the four required buckets did not parse at all — an empty bucket
 *  that failed to match `bucketRe` looks identical to a bucket that was never written,
 *  which is exactly why item 36 calls the old generic array-diff unhelpful here. */
function findMissingBuckets(buckets: Bucket[]): string[] {
  const present = new Set(buckets.map((b) => b.label));
  return REQUIRED_BUCKETS.filter((label) => !present.has(label));
}

/** Verbatim lift of the declared-vs-actual check so a fixture test can exercise it
 *  without touching the real ledger; the message text is unchanged from before the
 *  lift. */
function findCountMismatches(buckets: Bucket[]): string[] {
  return buckets
    .filter((b) => b.declared !== b.items.length)
    .map(
      (b) =>
        `"${b.label}" declares (${b.declared}) but lists ${b.items.length} item(s): ` +
        `${b.items.join(", ")}`
    );
}

/** Which heading numbers appear in no bucket's item list at all. Presence-only, so a
 *  Set suffices here even though the "no duplicates" check below still needs the
 *  fuller per-item bucket-label tracking and keeps its own copy of that loop. */
function computeMissingItems(headings: Heading[], buckets: Bucket[]): number[] {
  const seen = new Set<number>();
  for (const b of buckets) for (const n of b.items) seen.add(n);
  return headings.map((h) => h.n).filter((n) => !seen.has(n));
}

describe("docs/deferred-work.md status snapshot mechanical check (ledger item 36)", () => {
  const raw = fs.readFileSync(LEDGER_PATH, "utf8");
  const lines = raw.split("\n");
  const headings = parseHeadings(lines);
  const buckets = parseSnapshotBuckets(lines);

  it("parses at least one heading and all four expected buckets", () => {
    expect(headings.length).toBeGreaterThan(0);
    const missing = findMissingBuckets(buckets);
    expect(missing, `Bucket(s) not found in the snapshot: ${missing.join(", ")}`).toEqual([]);
  });

  it('the "Closed" bucket matches exactly the items whose heading starts "Closed —"', () => {
    const closedBucket = buckets.find((b) => b.label === "Closed");
    if (!closedBucket) throw new Error('No "Closed" bucket found in the snapshot.');

    const snapshotClosed = [...closedBucket.items].sort((a, b) => a - b);
    const headingClosed = headings
      .filter((h) => h.closed)
      .map((h) => h.n)
      .sort((a, b) => a - b);

    const onlyInSnapshot = snapshotClosed.filter((n) => !headingClosed.includes(n));
    const onlyInHeadings = headingClosed.filter((n) => !snapshotClosed.includes(n));

    expect(
      onlyInSnapshot,
      `Item(s) ${onlyInSnapshot.join(", ")} are in the snapshot's Closed bucket, but their ` +
        `heading does not start "Closed —".`
    ).toEqual([]);
    expect(
      onlyInHeadings,
      `Item(s) ${onlyInHeadings.join(", ")} have a "Closed —" heading, but are missing from ` +
        `the snapshot's Closed bucket.`
    ).toEqual([]);
  });

  it("every bucket's declared count matches its actual list length", () => {
    const mismatches = findCountMismatches(buckets);
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("every ledger item appears in exactly one bucket — no duplicates, none missing", () => {
    const seen = new Map<number, string[]>();
    for (const b of buckets) {
      for (const n of b.items) {
        const arr = seen.get(n) ?? [];
        arr.push(b.label);
        seen.set(n, arr);
      }
    }

    const duplicated = [...seen.entries()]
      .filter(([, labels]) => labels.length > 1)
      .map(([n, labels]) => `item ${n} appears in ${labels.length} buckets: ${labels.join(", ")}`);
    const missing = computeMissingItems(headings, buckets);

    expect(duplicated, duplicated.join("\n")).toEqual([]);
    expect(
      missing,
      `Item(s) ${missing.join(", ")} have a heading but appear in no snapshot bucket.`
    ).toEqual([]);
  });
});

/** Builds a minimal snapshot-section fixture — heading lines, then the bucket
 *  paragraphs framed exactly as parseSnapshotBuckets requires (a "## Status snapshot"
 *  marker, blank-line-separated paragraphs, a terminating "---"). Never touches
 *  LEDGER_PATH or the real ledger file. */
function buildSnapshotLines(headingLines: string[], bucketParagraphs: string[]): string[] {
  return [
    ...headingLines,
    "",
    "## Status snapshot",
    "",
    ...bucketParagraphs.flatMap((p) => [p, ""]),
    "---",
  ];
}

describe("fixture-driven: empty buckets and named failures", () => {
  it("all four buckets empty, zero headings — parses cleanly", () => {
    const lines = buildSnapshotLines(
      [],
      [
        "**Closed** (0):",
        "**Actionable now** (0):",
        "**Blocked on data** (0):",
        "**Neither** (0):",
      ]
    );
    const buckets = parseSnapshotBuckets(lines);

    expect(buckets.find((b) => b.label === "Neither")).toEqual({
      label: "Neither",
      declared: 0,
      items: [],
    });
    expect(findMissingBuckets(buckets)).toEqual([]);
    expect(findCountMismatches(buckets)).toEqual([]);
  });

  // Part 1 of this commit makes an empty bucket parse instead of vanishing. The risk
  // that creates is a false negative: an item that belongs nowhere could in principle
  // go unreported if an empty-but-now-valid bucket were mistaken for "this item is
  // accounted for." This block is the regression guard on that risk, not a test of
  // orphan-detection itself — computeMissingItems already existed in spirit as
  // assertion 4's inline logic; what's new here is confirming it still fires when
  // every bucket in the document is the newly-legal empty shape.
  it("an item with no bucket is still reported missing when every bucket is empty", () => {
    const lines = buildSnapshotLines(
      ["## 6. Some entry"],
      [
        "**Closed** (0):",
        "**Actionable now** (0):",
        "**Blocked on data** (0):",
        "**Neither** (0):",
      ]
    );
    const headings = parseHeadings(lines);
    const buckets = parseSnapshotBuckets(lines);

    expect(computeMissingItems(headings, buckets)).toEqual([6]);
    // Isolates the failure to item membership, not bucket presence — all four
    // buckets did parse, they just don't happen to list item 6.
    expect(findMissingBuckets(buckets)).toEqual([]);
  });

  it("a non-empty bucket's declared count disagreeing with its list names the bucket and both numbers", () => {
    const lines = buildSnapshotLines(
      ["## 1. First", "## 2. Second", "## 3. Third"],
      [
        "**Closed** (0):",
        "**Actionable now** (0):",
        "**Blocked on data** (4): 1, 2, 3",
        "**Neither** (0):",
      ]
    );
    const buckets = parseSnapshotBuckets(lines);

    expect(findCountMismatches(buckets)).toEqual([
      '"Blocked on data" declares (4) but lists 3 item(s): 1, 2, 3',
    ]);
  });

  it("a required bucket missing from the snapshot text entirely is named", () => {
    const lines = buildSnapshotLines(
      ["## 1. First"],
      ["**Closed** (1): 1", "**Actionable now** (0):", "**Blocked on data** (0):"]
    );
    const buckets = parseSnapshotBuckets(lines);

    expect(findMissingBuckets(buckets)).toEqual(["Neither"]);
  });
});
