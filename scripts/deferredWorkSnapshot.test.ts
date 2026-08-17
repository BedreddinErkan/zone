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
  /** Line index of the "## N. ..." heading itself — the entry body runs from
   *  here to the next heading (or the snapshot section). Added for item 218's
   *  in-entry bucket parse; the two original consumers (assertion 2 and
   *  computeMissingItems) only ever read `n`/`closed` and are unaffected. */
  line: number;
}

interface Bucket {
  label: string;
  declared: number;
  items: number[];
}

export function parseHeadings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  lines.forEach((line, i) => {
    const m = /^## (\d+)\. (.*)$/.exec(line);
    if (m) out.push({ n: Number(m[1]), closed: /^Closed —/.test(m[2]!), line: i });
  });
  return out;
}

// ─── Item 218: in-entry bucket classification ──────────────────────────────────────────────────
//
// Four heuristics, each added during this pass's own establish work to fix a specific misread —
// not designed up front. The fixture tests below (see "parseInEntryBuckets — fixture-driven")
// prove each one is load-bearing by constructing the exact shape that defeated the heuristic's
// predecessor, and asserting this parser and that predecessor disagree on it.
//
//  1. Form-agnostic marker match — colon, em-dash, comma, and the past-tense "Bucketed" variant
//     all count. A colon-only regex undercounted by 19 entries in an earlier pass (item 218).
//  2. The LAST marker occurrence in an entry wins, not the first — an entry that narrates a
//     transition across two separate sentences ("was X" ... later "now Y", e.g. items 203/204)
//     states its current bucket last.
//  3. Within that occurrence's own short window, the EARLIEST bucket word BY POSITION wins, not
//     a fixed priority order and not an unbounded scan. Nearly every entry's rationale contains
//     "**Against Actionable now:**" boilerplate explaining what it is NOT; an unbounded scan or a
//     fixed-priority list is fooled by that text into reporting the wrong bucket.
//  4. A single-sentence transition ("X becomes Y", "X → Y") resolves to Y, the current state —
//     items 153, 161, 162 all use this phrasing for a Closed verdict.
//  5. "moved out of X" names the FORMER bucket, not the current one (item 36) — the word is
//     blanked out before the earliest-word scan runs, rather than being treated as a candidate
//     that happens to lose a priority contest, so it cannot be picked even when nothing else in
//     the window outranks it. Item 36's real current bucket sits 388 characters past the marker
//     — past what heuristic 3 can safely reach without risking the boilerplate problem heuristic
//     3 exists to avoid — so heuristic 5 does not make item 36 auto-resolve to "Neither"; it
//     converts a confidently WRONG answer ("Actionable now") into an honest null, the same
//     outcome items 61 and 62 already have. Null is what both assertions below correctly treat
//     as "not auto-verifiable," never as a guess.
const BUCKET_WORDS = ["Blocked on data", "Actionable now", "Closed", "Neither"] as const;
const IN_ENTRY_MARKER_RE = /\*\*Bucket(?:ed\b|\s*[:—,])/g;
const TRANSITION_RE = new RegExp(
  `(${BUCKET_WORDS.join("|")})\\s*(?:becomes|→)\\s*(${BUCKET_WORDS.join("|")})`
);
/** Blanks a "moved out of X" span to the same length (never shifts later indices) so heuristic 5
 *  can run once, before both the transition check and the earliest-word scan. */
const MOVED_OUT_OF_RE = new RegExp(`moved\\s+out\\s+of\\s+(?:${BUCKET_WORDS.join("|")})`, "gi");
function blankFormerBucketMentions(window: string): string {
  return window.replace(MOVED_OUT_OF_RE, (m) => " ".repeat(m.length));
}
/** Long enough to reach past a short rationale clause into "**Against ...**" boilerplate that
 *  should NOT be searched — short is what makes heuristic 3 correct, not a larger number. */
const MARKER_WINDOW_CHARS = 160;

/** Existence only — does this entry's body carry a marker in any form at all? This is the
 *  criterion the backfill's own population (E1: 74 items) was scoped against, and it is
 *  deliberately weaker than `extractBucketFromEntryBody` below: an entry can carry a marker
 *  whose bucket word sits too far into its own paragraph for the tight extraction window to
 *  reach, or is deliberately blanked by heuristic 5 (items 36, 61, 62 — all three confirmed by
 *  direct reading to agree with their index bucket, and none counted as "missing" by E1's own
 *  instruments, which used this same existence check).
 *  Extraction failing to find a word nearby is not the same claim as no marker being present. */
export function hasInEntryMarker(body: string): boolean {
  return new RegExp(IN_ENTRY_MARKER_RE.source).test(body);
}

/** Extracts the bucket an entry's own text states, independent of the index list. Null when no
 *  marker is present, OR when a marker is present but no bucket word falls inside the short
 *  window after it (a best-effort limit, not a defect — see `hasInEntryMarker`'s doc). Either
 *  way, null is deliberately never coerced to a guess. */
export function extractBucketFromEntryBody(body: string): string | null {
  const matches = [...body.matchAll(IN_ENTRY_MARKER_RE)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const window = blankFormerBucketMentions(body.slice(last.index, last.index + MARKER_WINDOW_CHARS));

  const transition = TRANSITION_RE.exec(window);
  if (transition) return transition[2]!;

  let best: string | null = null;
  let bestIdx = Infinity;
  for (const w of BUCKET_WORDS) {
    const i = window.indexOf(w);
    if (i !== -1 && i < bestIdx) {
      bestIdx = i;
      best = w;
    }
  }
  return best;
}

/** entry number -> its own body text (heading line to next heading, or to the snapshot section
 *  for the last entry). Shared by both per-entry maps below so the boundary logic exists once. */
export function entryBodiesByNumber(lines: string[], headings: Heading[]): Map<number, string> {
  const snapshotStart = lines.findIndex((l) => /^## Status snapshot/.test(l));
  const result = new Map<number, string>();
  for (let idx = 0; idx < headings.length; idx++) {
    const { n, line } = headings[idx]!;
    const endLine =
      idx + 1 < headings.length
        ? headings[idx + 1]!.line
        : snapshotStart === -1
          ? lines.length
          : snapshotStart;
    result.set(n, lines.slice(line, endLine).join("\n"));
  }
  return result;
}

/** entry number -> whether its body carries a marker at all (existence — see `hasInEntryMarker`). */
function parseInEntryMarkerExistence(lines: string[], headings: Heading[]): Map<number, boolean> {
  const bodies = entryBodiesByNumber(lines, headings);
  const result = new Map<number, boolean>();
  for (const [n, body] of bodies) result.set(n, hasInEntryMarker(body));
  return result;
}

/** entry number -> stated bucket (or null — no marker, or a marker whose word extraction
 *  couldn't reach; see `extractBucketFromEntryBody`'s doc for the distinction). */
function parseInEntryBuckets(lines: string[], headings: Heading[]): Map<number, string | null> {
  const bodies = entryBodiesByNumber(lines, headings);
  const result = new Map<number, string | null>();
  for (const [n, body] of bodies) result.set(n, extractBucketFromEntryBody(body));
  return result;
}

/**
 * A naive extractor mirroring this pass's own first attempt: unbounded window (well past any
 * realistic entry length), fixed-priority-order word search instead of earliest-by-position, no
 * transition handling. Kept ONLY so the fixture tests below can prove their fixtures actually
 * discriminate — never used by the real parser or the real assertions. A fixture where this and
 * `extractBucketFromEntryBody` return the same value tests nothing.
 */
function naiveWideWindowExtract(body: string): string | null {
  const m = /\*\*Bucket(?:ed\b|\s*[:—,])/.exec(body);
  if (!m) return null;
  const window = body.slice(m.index, m.index + 2000);
  for (const w of BUCKET_WORDS) {
    if (window.includes(w)) return w;
  }
  return null;
}

/** The historical bug named in item 218: a colon-anchored marker regex. Kept ONLY to prove the
 *  separator-form fixtures discriminate against it. */
function colonOnlyExtract(body: string): string | null {
  const m = /\*\*Bucket:\s*(Blocked on data|Actionable now|Closed|Neither)/.exec(body);
  return m ? m[1]! : null;
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

describe("extractBucketFromEntryBody — fixture-driven, each fixture proven to discriminate", () => {
  it("boilerplate naming a bucket the entry is NOT in does not fool the extractor", () => {
    const body = [
      "**Bucket: Neither.** A structural fact is recorded and no fix is proposed.",
      "**Against Actionable now:** no fix is specified here — three open questions remain.",
    ].join("\n");
    expect(extractBucketFromEntryBody(body)).toBe("Neither");
    // Discrimination proof: an unbounded scan is fooled by the boilerplate it should never reach.
    expect(naiveWideWindowExtract(body)).toBe("Actionable now");
    expect(extractBucketFromEntryBody(body)).not.toBe(naiveWideWindowExtract(body));
  });

  it("two bucket words present — the earlier one BY POSITION is correct, not the one a fixed priority order would pick first", () => {
    const body =
      "**Bucket: Neither.** The entry mentions that Blocked on data was considered and rejected as a reading.";
    expect(extractBucketFromEntryBody(body)).toBe("Neither");
    // naiveWideWindowExtract checks "Blocked on data" before "Neither" regardless of where each
    // actually sits in the text — the priority-order bug, independent of the window-size bug above.
    expect(naiveWideWindowExtract(body)).toBe("Blocked on data");
    expect(extractBucketFromEntryBody(body)).not.toBe(naiveWideWindowExtract(body));
  });

  it('single-sentence transition "X becomes Y" resolves to Y, the current state', () => {
    const body = "**Bucket: Blocked on data becomes Closed.** The observation now exists.";
    expect(extractBucketFromEntryBody(body)).toBe("Closed");
    expect(naiveWideWindowExtract(body)).toBe("Blocked on data");
    expect(extractBucketFromEntryBody(body)).not.toBe(naiveWideWindowExtract(body));
  });

  it('single-sentence transition "X → Y" resolves to Y', () => {
    const body = "**Bucket: Actionable now → Closed**, two-way check. For: the fix specified is built.";
    expect(extractBucketFromEntryBody(body)).toBe("Closed");
    expect(naiveWideWindowExtract(body)).toBe("Actionable now");
    expect(extractBucketFromEntryBody(body)).not.toBe(naiveWideWindowExtract(body));
  });

  it("two SEPARATE bucket sentences (a transition narrated across the entry, not one sentence) — the LAST one wins", () => {
    const body = [
      "**Bucket: was Actionable now.** The change is specified and small, at three sites.",
      "The fix landed.",
      "**Bucket: Closed.** The field now names where its reason came from at every terminal exit.",
    ].join("\n");
    expect(extractBucketFromEntryBody(body)).toBe("Closed");
    // A first-match extractor (rather than last-match) would report the stale "Actionable now".
    const firstMatch = /\*\*Bucket:\s*(?:was\s+)?(Blocked on data|Actionable now|Closed|Neither)/.exec(body);
    expect(firstMatch?.[1]).toBe("Actionable now");
    expect(extractBucketFromEntryBody(body)).not.toBe(firstMatch?.[1]);
  });

  it('"moved out of X" names the FORMER bucket — heuristic 5 turns a confidently wrong answer into an honest null (real item-36 text, verbatim)', () => {
    const body =
      "**Bucket, moved out of Actionable now — and the precedent pointed at the mismatch all along.** That\n" +
      "bucket requires a fix specified in the entry with nothing left to learn. What remains here is the\n" +
      "opposite: an explicit decision *not* to build, plus a recorded technique. **Item 46 names this\n" +
      "entry's currency half as its own precedent for the decision-not-fix shape, and item 46 sits in\n" +
      "Neither**; item 38 cites the same shape and is also in Neither.";
    // The real current bucket ("Neither") sits past the window — this fixture does not claim
    // extraction reaches it, only that it no longer confidently reports the wrong one.
    expect(extractBucketFromEntryBody(body)).toBeNull();
    expect(hasInEntryMarker(body)).toBe(true);
    expect(naiveWideWindowExtract(body)).toBe("Actionable now");
    expect(extractBucketFromEntryBody(body)).not.toBe(naiveWideWindowExtract(body));
  });

  it("colon form", () => {
    expect(extractBucketFromEntryBody("**Bucket: Closed.** Fixed.")).toBe("Closed");
  });

  it("em-dash form — a colon-only instrument misses this entirely", () => {
    const body = "**Bucket — Closed.** This entry's own stated closure condition was met.";
    expect(extractBucketFromEntryBody(body)).toBe("Closed");
    expect(colonOnlyExtract(body)).toBeNull();
    expect(extractBucketFromEntryBody(body)).not.toBe(colonOnlyExtract(body));
  });

  it("comma form — a colon-only instrument misses this entirely (real item-11776 phrasing)", () => {
    const body =
      "**Bucket, re-decided rather than inherited: Neither becomes Closed.** This entry's own question was which bucket fit.";
    expect(extractBucketFromEntryBody(body)).toBe("Closed");
    expect(colonOnlyExtract(body)).toBeNull();
    expect(extractBucketFromEntryBody(body)).not.toBe(colonOnlyExtract(body));
  });

  it("past-tense 'Bucketed' form — a colon-only instrument misses this entirely", () => {
    const body = "the run left the entry in a settled state. **Bucketed Neither.**";
    expect(extractBucketFromEntryBody(body)).toBe("Neither");
    expect(colonOnlyExtract(body)).toBeNull();
    expect(extractBucketFromEntryBody(body)).not.toBe(colonOnlyExtract(body));
  });

  it("no marker at all returns null, not a guess", () => {
    const body = "**What it is.** Just prose describing the defect, no classification sentence anywhere in the entry.";
    expect(extractBucketFromEntryBody(body)).toBeNull();
    expect(hasInEntryMarker(body)).toBe(false);
  });

  it("a marker present but its bucket word too far into the paragraph for the window to reach — existence and extraction disagree, and that is correct (real item-61 shape)", () => {
    const body =
      "**Bucket, re-decided after the first bullet closed rather than inherited.** " +
      "x".repeat(200) +
      " That is Neither's own definition met directly, not on balance.";
    expect(hasInEntryMarker(body)).toBe(true);
    expect(extractBucketFromEntryBody(body)).toBeNull();
  });
});

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

// ─── Item 218: every entry's bucket must be checkable inside the entry, not only the index ────
describe("every entry states its own bucket, and it agrees with the index (ledger item 218)", () => {
  const raw = fs.readFileSync(LEDGER_PATH, "utf8");
  const lines = raw.split("\n");
  const headings = parseHeadings(lines);
  const buckets = parseSnapshotBuckets(lines);
  const hasMarker = parseInEntryMarkerExistence(lines, headings);
  const inEntry = parseInEntryBuckets(lines, headings);

  const indexOf = new Map<number, string>();
  for (const b of buckets) for (const n of b.items) indexOf.set(n, b.label);

  it("every entry states its bucket in its own text, or carries the 'Closed —' heading assertion 2 already checks", () => {
    // A Closed-headed entry's classification is checked by assertion 2 above (the heading set
    // must equal the Closed bucket set) — item 218 established that population as already
    // checkable and scoped the backfill to the remainder. Requiring an in-entry sentence from
    // them too would demand work item 218 never asked for and this pass never did.
    //
    // Existence, not extraction: an entry can carry a marker whose bucket word this file's
    // extractor cannot reach within its window (items 61, 62) without that being a missing
    // marker — see hasInEntryMarker's doc. That distinction is what keeps this assertion aligned
    // with E1's own instrument rather than a stricter, unintended one.
    const missing = headings.filter((h) => !h.closed && !hasMarker.get(h.n)).map((h) => h.n);
    expect(
      missing,
      `Item(s) with no in-entry bucket sentence: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every entry's stated bucket agrees with its index-list bucket", () => {
    const disagreements = headings
      .map((h) => ({ n: h.n, stated: inEntry.get(h.n) ?? null, indexed: indexOf.get(h.n) }))
      .filter((r) => r.stated != null && r.stated !== r.indexed)
      .map((r) => `item ${r.n} states "${r.stated}" but the index lists "${r.indexed}"`);
    expect(disagreements, disagreements.join("\n")).toEqual([]);
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
