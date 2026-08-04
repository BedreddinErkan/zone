/**
 * Characterization tests for segmentApplyPatchBlocks (ledger item 16 prerequisite).
 *
 * Extracted verbatim from apply_patch's inline walk in toolExecutor.ts — these pin what it
 * does today, byte for byte, including the known defects, mirroring
 * agentLoop.patchBlocksCharacterization.test.ts's coverage of parsePatchBlocks so the two
 * are directly comparable. Not a fix. Where current behavior looks wrong (the item-2
 * misparse), the test pins it anyway with a comment saying so.
 *
 * Every expected value below was derived by running segmentApplyPatchBlocks (and, for the
 * comparison cases, parsePatchBlocks) directly and reading the real output — not reasoned
 * about in advance.
 */
import { describe, it, expect } from "vitest";
import { segmentApplyPatchBlocks } from "./toolExecutor.js";
import { parsePatchBlocks, hashPatchBlocks } from "../llm/agentLoop.js";

const FIND = "--- FIND ---";
const REPLACE = "--- REPLACE ---";

describe("segmentApplyPatchBlocks — direct", () => {
  it("single block: trim strips exactly one leading/trailing newline, no more", () => {
    const singleNoPad = `${FIND}\nfoo\n${REPLACE}\nbar`;
    const singleDoublePad = `${FIND}\nfoo\n\n${REPLACE}\nbar`; // one extra blank line before REPLACE

    expect(segmentApplyPatchBlocks(singleNoPad)).toEqual({
      blocks: [{ find: "foo", replace: "bar" }],
      sqFindTotal: 0,
      sqReplaceTotal: 0,
    });
    // A future `.trim()`-style "fix" would collapse both to "foo" and collide here.
    expect(segmentApplyPatchBlocks(singleNoPad)).not.toEqual(segmentApplyPatchBlocks(singleDoublePad));
  });

  it("two well-formed blocks split correctly, each block's content reflected independently in the parsed result", () => {
    const twoBlocks = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\nbeta\n${REPLACE}\nBETA`;
    const twoBlocksVariant = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\nbeta\n${REPLACE}\nGAMMA`;

    expect(segmentApplyPatchBlocks(twoBlocks)).toEqual({
      blocks: [
        { find: "alpha", replace: "ALPHA" },
        { find: "beta", replace: "BETA" },
      ],
      sqFindTotal: 0,
      sqReplaceTotal: 0,
    });
    expect(segmentApplyPatchBlocks(twoBlocks)).not.toEqual(segmentApplyPatchBlocks(twoBlocksVariant));
  });

  it("a dangling FIND with no following REPLACE contributes nothing — parsing stops at the repIdx===-1 break, the tail is silently dropped", () => {
    const danglingWithTail = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\ntrailing text with no replace marker`;
    const danglingWithoutTail = `${FIND}\nalpha\n${REPLACE}\nALPHA\n`;

    expect(segmentApplyPatchBlocks(danglingWithTail)).toEqual({
      blocks: [{ find: "alpha", replace: "ALPHA" }],
      sqFindTotal: 0,
      sqReplaceTotal: 0,
    });
    // Equality, not difference: the claim is that the dangling tail changes nothing.
    expect(segmentApplyPatchBlocks(danglingWithTail)).toEqual(segmentApplyPatchBlocks(danglingWithoutTail));
  });

  it("two consecutive FIND markers: the second marker's literal text is absorbed into the first block's find, not treated as a new block", () => {
    const ffPatch = `${FIND}\nalpha\n${FIND}\nbeta\n${REPLACE}\nBETA`;
    const ffPatchVariant = `${FIND}\nalpha\n${FIND}\ngamma\n${REPLACE}\nBETA`;

    expect(segmentApplyPatchBlocks(ffPatch)).toEqual({
      blocks: [{ find: "alpha\n--- FIND ---\nbeta", replace: "BETA" }],
      sqFindTotal: 0,
      sqReplaceTotal: 0,
    });
    expect(segmentApplyPatchBlocks(ffPatch)).not.toEqual(segmentApplyPatchBlocks(ffPatchVariant));
  });

  it("item 2's known misparse: an embedded matched FIND/REPLACE pair (e.g. a doc example) truncates the real block's replace and fabricates a second block — pinned deliberately, not desired behavior", () => {
    const embedded = `${FIND}\n## Usage\n${REPLACE}\n## Usage\n\nExample:\n\n${FIND}\nconst t = 30;\n${REPLACE}\nconst t = 60;`;
    const embeddedVariant = `${FIND}\n## Usage\n${REPLACE}\n## Usage\n\nExample:\n\n${FIND}\nconst u = 1;\n${REPLACE}\nconst u = 2;`;

    expect(segmentApplyPatchBlocks(embedded)).toEqual({
      blocks: [
        { find: "## Usage", replace: "## Usage\n\nExample:\n" },
        { find: "const t = 30;", replace: "const t = 60;" },
      ],
      sqFindTotal: 0,
      sqReplaceTotal: 0,
    });
    expect(segmentApplyPatchBlocks(embedded)).not.toEqual(segmentApplyPatchBlocks(embeddedVariant));
    // Identical to parsePatchBlocks's own pinned value for this exact input — confirming,
    // for this specific shape too, that segmentation itself is unchanged by extraction.
    expect(segmentApplyPatchBlocks(embedded).blocks).toEqual(parsePatchBlocks(embedded));
  });

  it("empty input produces no blocks and zero smart-quote counts", () => {
    expect(segmentApplyPatchBlocks("")).toEqual({ blocks: [], sqFindTotal: 0, sqReplaceTotal: 0 });
  });

  it("input with no markers at all produces no blocks", () => {
    const noMarkers = "just some plain text with no markers in it at all";
    expect(segmentApplyPatchBlocks(noMarkers)).toEqual({ blocks: [], sqFindTotal: 0, sqReplaceTotal: 0 });
  });

  it("CRLF line endings inside find/replace content survive unparsed — only the marker-adjacent leading/trailing newline is stripped, internal \\r\\n is untouched", () => {
    const crlfPatch = `${FIND}\r\nline1\r\nline2\r\n${REPLACE}\r\nline3\r\nline4`;
    const lfPatch = `${FIND}\nline1\nline2\n${REPLACE}\nline3\nline4`;

    expect(segmentApplyPatchBlocks(crlfPatch)).toEqual({
      blocks: [{ find: "line1\r\nline2", replace: "line3\r\nline4" }],
      sqFindTotal: 0,
      sqReplaceTotal: 0,
    });
    // If CRLF were normalized to LF inside the walk, this would collide with the LF-only patch.
    expect(segmentApplyPatchBlocks(crlfPatch)).not.toEqual(segmentApplyPatchBlocks(lfPatch));
  });

  it("the divergence from parsePatchBlocks the ledger recorded is closed: both normalize smart quotes now", () => {
    const curly = `${FIND}\nconst label = “hello”;\n${REPLACE}\nconst label = "world";`;

    const walkResult = segmentApplyPatchBlocks(curly);
    const parseResult = parsePatchBlocks(curly);

    expect(walkResult.blocks).toEqual([{ find: 'const label = "hello";', replace: 'const label = "world";' }]);
    expect(walkResult.sqFindTotal).toBe(2); // opening + closing curly quote, both on the FIND side
    expect(walkResult.sqReplaceTotal).toBe(0); // REPLACE already used straight quotes

    // parsePatchBlocks now shares normalizeSmartQuotes with the walk (ledger item 18) — the
    // same normalized value, not the raw curly quotes this test used to pin.
    expect(parseResult).toEqual([{ find: 'const label = "hello";', replace: 'const label = "world";' }]);

    expect(walkResult.blocks[0]!.find).toBe(parseResult[0]!.find);
    expect(walkResult.blocks[0]!.replace).toBe(parseResult[0]!.replace);
  });

  it("CRLF is NOT a divergence axis — both functions leave it equally untouched, contrary to a brief's claim this session that the walk normalizes it", () => {
    const crlfPatch = `${FIND}\r\nline1\r\nline2\r\n${REPLACE}\r\nline3\r\nline4`;

    const walkResult = segmentApplyPatchBlocks(crlfPatch);
    const parseResult = parsePatchBlocks(crlfPatch);

    expect(walkResult.blocks).toEqual(parseResult);
  });

  it("double smart quotes converge to the same hash between the two paths — quotes on both find and replace", () => {
    const curly = `${FIND}\nconst label = “hello”;\n${REPLACE}\nconst label = “world”;`;
    const straight = `${FIND}\nconst label = "hello";\n${REPLACE}\nconst label = "world";`;

    // Symmetric mutations (both sides call the same shared function): blind to this assertion,
    // since segmentApplyPatchBlocks and parsePatchBlocks would still agree with each other.
    expect(segmentApplyPatchBlocks(curly).blocks).toEqual(parsePatchBlocks(curly));
    // What actually proves normalization happened at all: the hash of a curly-quote patch now
    // matches the hash of its straight-quote equivalent, which has nothing to normalize.
    expect(hashPatchBlocks({ patch: curly })).toBe(hashPatchBlocks({ patch: straight }));
  });

  it("single smart quotes converge too — a fix that only handles double quotes must fail this", () => {
    const curly = `${FIND}\nconst label = ‘hello’;\n${REPLACE}\nconst label = ‘world’;`;
    const straight = `${FIND}\nconst label = 'hello';\n${REPLACE}\nconst label = 'world';`;

    expect(segmentApplyPatchBlocks(curly).blocks).toEqual(parsePatchBlocks(curly));
    expect(hashPatchBlocks({ patch: curly })).toBe(hashPatchBlocks({ patch: straight }));
  });
});
