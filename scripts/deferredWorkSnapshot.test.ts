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

  const bucketRe = /^\*\*(.+?)\*\*.*?\((\d+)\):\s*(.+)$/;
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

describe("docs/deferred-work.md status snapshot mechanical check (ledger item 36)", () => {
  const raw = fs.readFileSync(LEDGER_PATH, "utf8");
  const lines = raw.split("\n");
  const headings = parseHeadings(lines);
  const buckets = parseSnapshotBuckets(lines);

  it("parses at least one heading and all four expected buckets", () => {
    expect(headings.length).toBeGreaterThan(0);
    expect(buckets.map((b) => b.label)).toEqual(
      expect.arrayContaining(["Closed", "Actionable now", "Blocked on data", "Neither"])
    );
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
    const mismatches = buckets
      .filter((b) => b.declared !== b.items.length)
      .map(
        (b) =>
          `"${b.label}" declares (${b.declared}) but lists ${b.items.length} item(s): ` +
          `${b.items.join(", ")}`
      );
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
    const missing = headings.map((h) => h.n).filter((n) => !seen.has(n));

    expect(duplicated, duplicated.join("\n")).toEqual([]);
    expect(
      missing,
      `Item(s) ${missing.join(", ")} have a heading but appear in no snapshot bucket.`
    ).toEqual([]);
  });
});
