/**
 * Deferred-work intra-entry spatial cross-reference lint.
 *
 * The anaphor and positional sweeps (`deferredWorkAnaphorSweep.ts`,
 * `deferredWorkPositionalSweep.ts`) already detect this exact shape — that is
 * not a coincidence to route around, it is why they caught the drift four
 * times across four passes in this project's own history (items 288/289/290,
 * the provider-resolution diagnosis, and the checkWriteScope diagnosis). The
 * gap was never detection: it was that a bare count mismatch ("53, expected
 * 52") names no file, no line, and no instruction, so each trip cost a fresh
 * throwaway locator script. This module does not reimplement the pattern — a
 * third independent copy is the exact defect class this repo already flags
 * elsewhere (`PATCH_MULTI_BLOCK_EXAMPLE`: "a third, still-independent copy of
 * the same format… not unified") — it imports both pattern-builders, unions
 * their matches by span, and reports the file, line, and matched text.
 *
 * ALLOWLIST DESIGN. Keyed on (enclosing item number, matched text), not text
 * alone. A text-only allowlist would silently pass a NEW instance of an
 * existing phrase appearing in a DIFFERENT entry — the closest failure mode
 * to what this document's own writing has actually done: the same handful of
 * spatial phrasings recurring across entries, not one instance repeating.
 * A bare-count check cannot distinguish "this phrase already existed
 * elsewhere" from "this phrase is brand new here"; keying on the pair can.
 * The item number comes from `parseHeadings`
 * (`deferredWorkHeadings.ts`, extracted from item 36's own machinery, not
 * reimplemented) rather than a line number, because line numbers drift on
 * every future edit — the same reason the sweeps key their own drift-safety
 * on match spans, not line positions.
 *
 * DISPOSITION. Every pair present as of the commit that introduced this lint
 * is pre-existing text and is allowlisted in bulk rather than individually
 * rewritten — rewriting the ledger's history is a different, much larger
 * content pass. The allowlist does NOT grow going forward: a new entry that
 * introduces a new spatial self-reference — including a reused phrase in a
 * different item — fails until the referent is named (an item number, a
 * file:line, a probe letter — anything stable, not a spatial pointer).
 * Extending the allowlist is a deliberate, audited act, asserted by the
 * lint's own test the same way `ANAPHOR_ABSOLUTE`/`POSITIONAL_*_ABSOLUTE` are.
 */
import { buildAnaphorPattern } from "./deferredWorkAnaphorSweep.js";
import { buildPositionalPattern } from "./deferredWorkPositionalSweep.js";
import { parseHeadings } from "./deferredWorkHeadings.js";

export interface SpatialReferenceMatch {
  /** Enclosing item number, or null if the match falls outside any entry's body
   *  (the preamble, or the Status snapshot section). */
  item: number | null;
  /** 1-indexed line the match starts on. */
  line: number;
  text: string;
}

/** Union of both existing patterns' matches, deduped by span (an anaphor match
 *  and a positional match covering the identical text are one hit, not two).
 *
 *  The scan is bounded to the numbered-items region — everything before the
 *  "## Status snapshot" heading, the same boundary `entryBodiesByNumber`
 *  (deferredWorkHeadings.ts) already uses for the last entry's span. Without
 *  this bound, `itemForLine` below has no next heading to stop the LAST
 *  numbered item at — `parseHeadings` only tracks "## N. " headings, not
 *  "## Status snapshot" or the untracked "pattern" essays that follow it — so
 *  the last item's span silently swallowed every line to the end of the file.
 *  This was not a theoretical risk: before this bound existed, the then-last
 *  item was credited with 22 matches that actually live in the Status
 *  snapshot prose and the pattern essays, none of which are ledger entries at
 *  all — confirmed by re-running this function before and after the bound was
 *  added and diffing the two (item, text) sequences. */
export function findSpatialReferences(text: string): SpatialReferenceMatch[] {
  const lines = text.split("\n");
  const headings = parseHeadings(lines);
  const snapshotLineIdx = lines.findIndex((l) => /^## Status snapshot/.test(l));
  const scanText =
    snapshotLineIdx === -1 ? text : lines.slice(0, snapshotLineIdx).join("\n");

  function spans(re: RegExp): Array<{ start: number; end: number; text: string }> {
    const out: Array<{ start: number; end: number; text: string }> = [];
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = r.exec(scanText)) !== null) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      if (m[0].length === 0) r.lastIndex++;
    }
    return out;
  }

  const all = [...spans(buildAnaphorPattern()), ...spans(buildPositionalPattern())].sort(
    (x, y) => x.start - y.start
  );
  const union: Array<{ start: number; end: number; text: string }> = [];
  for (const s of all) {
    const last = union[union.length - 1];
    if (last && s.start < last.end) continue; // overlaps a span already kept
    union.push(s);
  }

  function lineOf(offset: number): number {
    return scanText.slice(0, offset).split("\n").length; // 1-indexed
  }
  function itemForLine(lineIdx0: number): number | null {
    // headings[].line is 0-indexed; lineIdx0 here is also 0-indexed. null is
    // still reachable — a match in the preamble, before "## 1.", has no
    // preceding heading — but nothing past the last item's own content can
    // produce it any more, because scanText never reaches that far.
    let found: number | null = null;
    for (const h of headings) {
      if (h.line <= lineIdx0) found = h.n;
      else break;
    }
    return found;
  }

  return union.map((s) => {
    const line0 = lineOf(s.start) - 1;
    return { item: itemForLine(line0), line: line0 + 1, text: s.text };
  });
}

export interface AllowedPair {
  item: number | null;
  text: string;
}

/** True when a match's (item, text) pair — occurrence-indexed, not deduped —
 *  is exactly accounted for by the allowlist at the same position. Callers
 *  compare the full sequence with `toEqual`, not this predicate alone, so a
 *  disappear-and-reappear-elsewhere substitution is caught by the sequence
 *  comparison even where a single-pair check would not catch it. */
export function toAllowedPairs(matches: SpatialReferenceMatch[]): AllowedPair[] {
  return matches.map((m) => ({ item: m.item, text: m.text }));
}
