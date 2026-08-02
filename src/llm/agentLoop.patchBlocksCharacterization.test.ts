/**
 * Characterization tests for parsePatchBlocks / hashPatchBlocks (ledger item 16).
 *
 * These pin what the code does TODAY, byte for byte — including the known defects — so a
 * later extraction of the shared FIND/REPLACE segmentation (agentLoop.ts's parsePatchBlocks vs
 * toolExecutor.ts's inline walk) is provably behavior-preserving. Not a fix. Where current
 * behavior looks wrong (the item-2 misparse, unnormalized smart quotes), the test pins it
 * anyway with a comment saying so.
 *
 * parsePatchBlocks (agentLoop.ts:1344) is NOT exported — confirmed by grep, zero hits, no
 * existing test imports it. That is itself a finding: the segmentation half of this format has
 * had no directly testable surface at all, which is plausibly why it silently diverged from the
 * walk's smart-quote handling (Phase V Commit 2) unnoticed. Every parsePatchBlocks-specific
 * claim below is therefore pinned only through the exported hashPatchBlocks, via two real calls
 * per claim: a hypothesis assertion (does the real hash equal the hash of a hand-written
 * find/replace guess, hashed with hashPatchBlocks's own formula) and a discriminating companion
 * (two real patches differing only in the property under test, asserted equal or unequal per
 * what the claim predicts).
 */
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hashPatchBlocks } from "./agentLoop.js";

const FIND = "--- FIND ---";
const REPLACE = "--- REPLACE ---";

/**
 * Mirrors hashPatchBlocks's own concatenation formula (agentLoop.ts:1371-1373) so a hand-written
 * {find, replace} hypothesis can be compared against the real hashed output without ever calling
 * the unexported parsePatchBlocks. If hashPatchBlocks's formula changes, this must change with
 * it — mutation 5 in the build report verifies a production formula change is actually caught by
 * at least one test here, i.e. that this helper is not a silent second source of truth.
 */
function expectedHash(blocks: Array<{ find: string; replace: string }>, rawFallback: string): string {
  const concatenated =
    blocks.length > 0
      ? blocks.map((b) => `${b.find}\n--\n${b.replace}`).join("\n===\n")
      : rawFallback;
  return createHash("sha256").update(concatenated).digest("hex").slice(0, 12);
}

describe("parsePatchBlocks — pinned indirectly via hashPatchBlocks (not exported)", () => {
  it("single block: trim strips exactly one leading/trailing newline, no more", () => {
    const singleNoPad = `${FIND}\nfoo\n${REPLACE}\nbar`;
    const singleDoublePad = `${FIND}\nfoo\n\n${REPLACE}\nbar`; // one extra blank line before REPLACE

    expect(hashPatchBlocks({ patch: singleNoPad })).toBe(
      expectedHash([{ find: "foo", replace: "bar" }], singleNoPad)
    );
    // A future `.trim()`-style "fix" would collapse both to "foo" and collide here.
    expect(hashPatchBlocks({ patch: singleNoPad })).not.toBe(hashPatchBlocks({ patch: singleDoublePad }));
  });

  it("two well-formed blocks split correctly, each block's content reflected independently in the hash", () => {
    const twoBlocks = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\nbeta\n${REPLACE}\nBETA`;
    const twoBlocksVariant = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\nbeta\n${REPLACE}\nGAMMA`;

    expect(hashPatchBlocks({ patch: twoBlocks })).toBe(
      expectedHash(
        [
          { find: "alpha", replace: "ALPHA" },
          { find: "beta", replace: "BETA" },
        ],
        twoBlocks
      )
    );
    expect(hashPatchBlocks({ patch: twoBlocks })).not.toBe(hashPatchBlocks({ patch: twoBlocksVariant }));
  });

  it("a dangling FIND with no following REPLACE contributes nothing — parsing stops at the repIdx===-1 break, the tail is silently dropped", () => {
    const danglingWithTail = `${FIND}\nalpha\n${REPLACE}\nALPHA\n${FIND}\ntrailing text with no replace marker`;
    const danglingWithoutTail = `${FIND}\nalpha\n${REPLACE}\nALPHA\n`;

    expect(hashPatchBlocks({ patch: danglingWithTail })).toBe(
      expectedHash([{ find: "alpha", replace: "ALPHA" }], danglingWithTail)
    );
    // Equality, not difference: the claim is that the dangling tail changes nothing.
    expect(hashPatchBlocks({ patch: danglingWithTail })).toBe(hashPatchBlocks({ patch: danglingWithoutTail }));
  });

  it("two consecutive FIND markers: the second marker's literal text is absorbed into the first block's find, not treated as a new block", () => {
    const ffPatch = `${FIND}\nalpha\n${FIND}\nbeta\n${REPLACE}\nBETA`;
    const ffPatchVariant = `${FIND}\nalpha\n${FIND}\ngamma\n${REPLACE}\nBETA`;

    expect(hashPatchBlocks({ patch: ffPatch })).toBe(
      expectedHash([{ find: "alpha\n--- FIND ---\nbeta", replace: "BETA" }], ffPatch)
    );
    expect(hashPatchBlocks({ patch: ffPatch })).not.toBe(hashPatchBlocks({ patch: ffPatchVariant }));
  });

  it("item 2's known misparse: an embedded matched FIND/REPLACE pair (e.g. a doc example) truncates the real block's replace and fabricates a second block — pinned deliberately, not desired behavior", () => {
    const embedded = `${FIND}\n## Usage\n${REPLACE}\n## Usage\n\nExample:\n\n${FIND}\nconst t = 30;\n${REPLACE}\nconst t = 60;`;
    const embeddedVariant = `${FIND}\n## Usage\n${REPLACE}\n## Usage\n\nExample:\n\n${FIND}\nconst u = 1;\n${REPLACE}\nconst u = 2;`;

    expect(hashPatchBlocks({ patch: embedded })).toBe(
      expectedHash(
        [
          { find: "## Usage", replace: "## Usage\n\nExample:\n" },
          { find: "const t = 30;", replace: "const t = 60;" },
        ],
        embedded
      )
    );
    expect(hashPatchBlocks({ patch: embedded })).not.toBe(hashPatchBlocks({ patch: embeddedVariant }));
  });

  it("CRLF line endings inside find/replace content survive unparsed — only the marker-adjacent leading/trailing newline is stripped, internal \\r\\n is untouched", () => {
    const crlfPatch = `${FIND}\r\nline1\r\nline2\r\n${REPLACE}\r\nline3\r\nline4`;
    const lfPatch = `${FIND}\nline1\nline2\n${REPLACE}\nline3\nline4`;

    expect(hashPatchBlocks({ patch: crlfPatch })).toBe(
      expectedHash([{ find: "line1\r\nline2", replace: "line3\r\nline4" }], crlfPatch)
    );
    // If CRLF were normalized to LF before hashing, this would collide with the LF-only patch.
    expect(hashPatchBlocks({ patch: crlfPatch })).not.toBe(hashPatchBlocks({ patch: lfPatch }));
  });

  it("smart quotes pass through unnormalized — diverges from the walk's normalizeSmartQuotes and from a straight-quote equivalent patch", () => {
    const curly = `${FIND}\nconst label = “hello”;\n${REPLACE}\nconst label = "world";`;
    const straight = `${FIND}\nconst label = "hello";\n${REPLACE}\nconst label = "world";`;

    expect(hashPatchBlocks({ patch: curly })).toBe(
      expectedHash([{ find: "const label = “hello”;", replace: 'const label = "world";' }], curly)
    );
    // The applier's walk normalizes curly quotes (toolExecutor.ts:41, normalizeSmartQuotes) before
    // hashing an equivalent patch; this parser does not (see ledger item 16). This is the defect
    // behind the identical_patch_retried miss (agentLoop.ts:1437): a model that "fixes" a failing
    // patch only by straightening its quotes is not recognized as retrying the same patch.
    expect(hashPatchBlocks({ patch: curly })).not.toBe(hashPatchBlocks({ patch: straight }));
  });
});

describe("hashPatchBlocks — direct", () => {
  it("a known two-block patch hashes to a fixed 12-character value", () => {
    // ANCHOR: the one test in this file with no formula replicated anywhere in its own path —
    // it pins the real output directly. This is what catches a change to hashPatchBlocks's
    // concatenation formula itself (see mutation 5 in the build report); every other test in
    // this file compares the real output against a hand-hypothesis run through `expectedHash`,
    // which duplicates that same formula and would drift right along with it. If this literal
    // ever needs updating, re-derive it by running hashPatchBlocks — never by recomputing it
    // with `expectedHash`, which would just re-encode whatever the formula currently is.
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

  it("{} hashes as the empty patch", () => {
    expect(hashPatchBlocks({})).toBe("e3b0c44298fc");
  });

  it('{patch: ""} hashes as the empty patch', () => {
    expect(hashPatchBlocks({ patch: "" })).toBe("e3b0c44298fc");
  });

  it("null args hashes as the empty patch", () => {
    expect(hashPatchBlocks(null)).toBe("e3b0c44298fc");
  });

  it("undefined args hashes as the empty patch", () => {
    expect(hashPatchBlocks(undefined)).toBe("e3b0c44298fc");
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
