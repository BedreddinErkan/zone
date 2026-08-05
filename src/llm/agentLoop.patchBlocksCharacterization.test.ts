/**
 * Characterization tests for parsePatchBlocks / hashPatchBlocks (ledger item 16; exporting
 * parsePatchBlocks and asserting on it directly here closes item 20).
 *
 * These pin what the code does TODAY, byte for byte — including the known defects — so a
 * later extraction of the shared FIND/REPLACE segmentation (agentLoop.ts's parsePatchBlocks vs
 * toolExecutor.ts's inline walk) is provably behavior-preserving. Not a fix. Where current
 * behavior looks wrong (the item-2 misparse, unnormalized smart quotes), the test pins it
 * anyway with a comment saying so.
 *
 * parsePatchBlocks is now exported and asserted on directly below — every
 * parsePatchBlocks-specific claim is a plain `expect(parsePatchBlocks(x)).toEqual(...)` or a
 * real-vs-real comparison of two parsed outputs, no hash indirection. Previously the function
 * was unreachable from any test (confirmed by grep, zero hits) and every claim went through the
 * exported hashPatchBlocks instead, via a hypothesis hashed with a test-local formula-mirroring
 * helper (`expectedHash`, now removed — its only callers were the seven assertions converted
 * here). That indirection remains, by necessity, for the ANCHOR case in the second describe
 * block below: that test exists specifically to pin hashPatchBlocks's OWN concatenation formula
 * (not parsePatchBlocks's segmentation) against a real, non-reproduced hash literal, and nothing
 * in the first describe block substitutes for it now that those tests no longer call
 * hashPatchBlocks at all. The rest of the second describe block is likewise about
 * hashPatchBlocks's own contract — args-shape tolerance, null/undefined/empty handling, the
 * raw-fallback branch — not about parsePatchBlocks's segmentation, so it stays as-is.
 */
import { describe, it, expect } from "vitest";
import { hashPatchBlocks, parsePatchBlocks } from "./agentLoop.js";
import { NO_PATCH_HASH_SENTINEL } from "./antiThrash.js";

const FIND = "--- FIND ---";
const REPLACE = "--- REPLACE ---";

describe("parsePatchBlocks — direct", () => {
  it("single block: trim strips exactly one leading/trailing newline, no more", () => {
    const singleNoPad = `${FIND}\nfoo\n${REPLACE}\nbar`;
    const singleDoublePad = `${FIND}\nfoo\n\n${REPLACE}\nbar`; // one extra blank line before REPLACE

    expect(parsePatchBlocks(singleNoPad)).toEqual([{ find: "foo", replace: "bar" }]);
    // A future `.trim()`-style "fix" would collapse both to "foo" and collide here.
    expect(parsePatchBlocks(singleNoPad)).not.toEqual(parsePatchBlocks(singleDoublePad));
  });

  it("two well-formed blocks split correctly, each block's content reflected independently in the parsed result", () => {
    const twoBlocks = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\nbeta\n${REPLACE}\nBETA`;
    const twoBlocksVariant = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\nbeta\n${REPLACE}\nGAMMA`;

    expect(parsePatchBlocks(twoBlocks)).toEqual([
      { find: "alpha", replace: "ALPHA" },
      { find: "beta", replace: "BETA" },
    ]);
    expect(parsePatchBlocks(twoBlocks)).not.toEqual(parsePatchBlocks(twoBlocksVariant));
  });

  it("a dangling FIND with no following REPLACE contributes nothing — parsing stops at the repIdx===-1 break, the tail is silently dropped", () => {
    const danglingWithTail = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\ntrailing text with no replace marker`;
    const danglingWithoutTail = `${FIND}\nalpha\n${REPLACE}\nALPHA\n`;

    expect(parsePatchBlocks(danglingWithTail)).toEqual([{ find: "alpha", replace: "ALPHA" }]);
    // Equality, not difference: the claim is that the dangling tail changes nothing.
    expect(parsePatchBlocks(danglingWithTail)).toEqual(parsePatchBlocks(danglingWithoutTail));
  });

  it("two consecutive FIND markers: the second marker's literal text is absorbed into the first block's find, not treated as a new block", () => {
    const ffPatch = `${FIND}\nalpha\n${FIND}\nbeta\n${REPLACE}\nBETA`;
    const ffPatchVariant = `${FIND}\nalpha\n${FIND}\ngamma\n${REPLACE}\nBETA`;

    expect(parsePatchBlocks(ffPatch)).toEqual([{ find: "alpha\n--- FIND ---\nbeta", replace: "BETA" }]);
    expect(parsePatchBlocks(ffPatch)).not.toEqual(parsePatchBlocks(ffPatchVariant));
  });

  it("item 2's known misparse: an embedded matched FIND/REPLACE pair (e.g. a doc example) truncates the real block's replace and fabricates a second block — pinned deliberately, not desired behavior", () => {
    const embedded = `${FIND}\n## Usage\n${REPLACE}\n## Usage\n\nExample:\n\n${FIND}\nconst t = 30;\n${REPLACE}\nconst t = 60;`;
    const embeddedVariant = `${FIND}\n## Usage\n${REPLACE}\n## Usage\n\nExample:\n\n${FIND}\nconst u = 1;\n${REPLACE}\nconst u = 2;`;

    expect(parsePatchBlocks(embedded)).toEqual([
      { find: "## Usage", replace: "## Usage\n\nExample:\n" },
      { find: "const t = 30;", replace: "const t = 60;" },
    ]);
    expect(parsePatchBlocks(embedded)).not.toEqual(parsePatchBlocks(embeddedVariant));
  });

  it("CRLF line endings inside find/replace content survive unparsed — only the marker-adjacent leading/trailing newline is stripped, internal \r\n is untouched", () => {
    const crlfPatch = `${FIND}\r\nline1\r\nline2\r\n${REPLACE}\r\nline3\r\nline4`;
    const lfPatch = `${FIND}\nline1\nline2\n${REPLACE}\nline3\nline4`;

    expect(parsePatchBlocks(crlfPatch)).toEqual([{ find: "line1\r\nline2", replace: "line3\r\nline4" }]);
    // If CRLF were normalized to LF by parsePatchBlocks, this would collide with the LF-only patch.
    expect(parsePatchBlocks(crlfPatch)).not.toEqual(parsePatchBlocks(lfPatch));
  });

  it("smart quotes are now normalized — converges with the walk and with a straight-quote equivalent patch", () => {
    const curly = `${FIND}\nconst label = “hello”;\n${REPLACE}\nconst label = "world";`;
    const straight = `${FIND}\nconst label = "hello";\n${REPLACE}\nconst label = "world";`;

    expect(parsePatchBlocks(curly)).toEqual([{ find: 'const label = "hello";', replace: 'const label = "world";' }]);
    // Ledger item 18: this parser now shares normalizeSmartQuotes (utils/smartQuotes.ts) with
    // the applier's walk in toolExecutor.ts — both sides compute the same normalized text. The
    // identical_patch_retried miss this divergence caused (detectRepeatedFailure's
    // identical_patch_retried branch, agentLoop.ts: a model "fixing" a failing patch only by
    // straightening its quotes was not recognized as retrying the same patch) no longer
    // reproduces.
    expect(parsePatchBlocks(curly)).toEqual(parsePatchBlocks(straight));
  });
});

describe("hashPatchBlocks — direct", () => {
  it("a known two-block patch hashes to a fixed 12-character value", () => {
    // ANCHOR: the one test in this file with no formula replicated anywhere in its own path —
    // it pins the real output directly. This is what catches a change to hashPatchBlocks's
    // concatenation formula itself; every other test in the first describe block now calls
    // parsePatchBlocks directly and no longer routes through this formula at all. If this
    // literal ever needs updating, re-derive it by running hashPatchBlocks — never by hand.
    // Fixture is multi-block (2 blocks — see the "two well-formed blocks" case above), so it
    // exercises the blocks.length > 0 concatenation path, not the raw-patch fallback.
    const knownPatch = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\nbeta\n${REPLACE}\nBETA`;
    expect(hashPatchBlocks({ patch: knownPatch })).toBe("42c039593bb9");
  });

  it("different args wrapper shapes around the same patch text produce the same hash", () => {
    const patch = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\nbeta\n${REPLACE}\nBETA`;
    const a = hashPatchBlocks({ patch });
    const b = hashPatchBlocks({ patch, extra: 1, another: "x" });
    expect(a).toBe(b);
  });

  it("{} hashes as the no-patch sentinel, not a collidable hash", () => {
    expect(hashPatchBlocks({})).toBe(NO_PATCH_HASH_SENTINEL);
  });

  it('{patch: ""} hashes as the no-patch sentinel', () => {
    expect(hashPatchBlocks({ patch: "" })).toBe(NO_PATCH_HASH_SENTINEL);
  });

  it("null args hashes as the no-patch sentinel", () => {
    expect(hashPatchBlocks(null)).toBe(NO_PATCH_HASH_SENTINEL);
  });

  it("undefined args hashes as the no-patch sentinel", () => {
    expect(hashPatchBlocks(undefined)).toBe(NO_PATCH_HASH_SENTINEL);
  });

  it("a realistic apply_patch call missing `patch` also hashes as the sentinel — not a category error, a live path (ledger item 17's establish): apply_patch's schema requires `patch`, but strict mode is dropped for Anthropic", () => {
    expect(hashPatchBlocks({ filePath: "src/a.ts", intent: "modify", scope: null })).toBe(NO_PATCH_HASH_SENTINEL);
  });

  it("a second, structurally different no-patch call — different file, different intent — hashes to the SAME sentinel as the one above (deliberate: there's no content to distinguish them by)", () => {
    expect(hashPatchBlocks({ filePath: "src/b.ts", intent: "delete", scope: null })).toBe(NO_PATCH_HASH_SENTINEL);
  });

  it("a no-patch call carrying a populated scope object still hashes as the sentinel — the sentinel depends only on `patch`, never on sibling fields", () => {
    expect(
      hashPatchBlocks({
        filePath: "src/a.ts",
        intent: "add",
        scope: { symbolName: "foo", symbolKind: "function", className: null },
      }),
    ).toBe(NO_PATCH_HASH_SENTINEL);
  });

  it("a patch with no FIND/REPLACE markers at all hashes the raw patch text", () => {
    const noMarkers = "just some plain text with no markers in it at all";
    expect(hashPatchBlocks({ patch: noMarkers })).toBe("0b403a357d2e");
  });

  it("the no-markers hash is distinct from the empty-patch hash", () => {
    const noMarkers = "just some plain text with no markers in it at all";
    expect(hashPatchBlocks({ patch: noMarkers })).not.toBe(hashPatchBlocks({}));
  });
});
