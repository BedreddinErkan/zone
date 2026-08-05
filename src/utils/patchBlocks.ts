import { normalizeSmartQuotes } from "./smartQuotes.js";

export interface FindReplaceBlock {
  find: string;
  replace: string;
}

/**
 * The FIND/REPLACE segmentation walk shared by `toolExecutor.ts`'s `segmentApplyPatchBlocks`
 * and `agentLoop.ts`'s `parsePatchBlocks` (ledger item 16 — the two were byte-identical apart
 * from this file's own count bookkeeping; this is the extraction). Forward index scan: find
 * the next FIND marker, the next REPLACE marker after it, the next FIND marker after that (or
 * end of string) closes the block. Normalizes smart quotes on each block's find/replace as
 * they're extracted — this is the ONE normalization step inside segmentation itself; CRLF/
 * bare-CR normalization happens later, per matched block, at match time, in `toolExecutor.ts`
 * (ledger item 18) — this function has no equivalent of that later step and never will.
 *
 * KNOWN DEFECT, NOT FIXED HERE: this walk uses the same substring-anywhere marker matching as
 * the imbalance check in `apply_patch`'s handler, so an embedded, own-line, MATCHED FIND/
 * REPLACE pair inside what should be one block's REPLACE content (e.g. a doc example showing
 * the apply_patch syntax) makes this loop split there — truncating the real block's
 * replacement short and fabricating a second, unintended block from the example text. The
 * imbalance check cannot catch this shape: a matched embedded pair raises both findMarkerCount
 * and replaceMarkerCount together, so they stay equal, the rejection branch never fires, and no
 * [zone-apply-patch-marker-imbalance] record of this can exist. Silent wrong-content write, not
 * a rejection — worse than the false positive that check addresses. Deliberately unfixed
 * pending its own pass: fixing it changes which patches get *accepted*, not just which get
 * rejected more legibly (ledger item 2).
 */
export function segmentPatchBlocks(patch: string): {
  blocks: FindReplaceBlock[];
  sqFindTotal: number;
  sqReplaceTotal: number;
} {
  const FIND_MARKER = "--- FIND ---";
  const REPLACE_MARKER = "--- REPLACE ---";
  const blocks: FindReplaceBlock[] = [];
  let remaining = String(patch || "");
  let sqFindTotal = 0;
  let sqReplaceTotal = 0;
  while (remaining.includes(FIND_MARKER)) {
    const findIdx = remaining.indexOf(FIND_MARKER);
    const afterFind = remaining.slice(findIdx + FIND_MARKER.length);
    const repIdx = afterFind.indexOf(REPLACE_MARKER);
    if (repIdx === -1) break;
    const findContent = afterFind.slice(0, repIdx);
    const afterReplace = afterFind.slice(repIdx + REPLACE_MARKER.length);
    const nextFindIdx = afterReplace.indexOf(FIND_MARKER);
    const replaceContent =
      nextFindIdx === -1 ? afterReplace : afterReplace.slice(0, nextFindIdx);

    const { text: normalizedFind, count: sqFind } = normalizeSmartQuotes(
      findContent.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
    );
    const { text: normalizedReplace, count: sqReplace } = normalizeSmartQuotes(
      replaceContent.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
    );
    sqFindTotal += sqFind;
    sqReplaceTotal += sqReplace;

    blocks.push({
      find: normalizedFind,
      replace: normalizedReplace,
    });
    remaining = nextFindIdx === -1 ? "" : afterReplace.slice(nextFindIdx);
  }
  return { blocks, sqFindTotal, sqReplaceTotal };
}
