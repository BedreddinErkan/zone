/**
 * Detection-only telemetry for ledger item 18. Segmentation and smart-quote normalization are
 * now shared: hashPatchBlocks (agentLoop.ts) reaches them through parsePatchBlocks, which wraps
 * the same segmenter the applier uses, so the dedup key reflects normalized quotes once a patch
 * parses into at least one block — a patch that produces none still hashes the raw string. What
 * the applier still does alone, per matched block at match time, is strip read_file's pasted
 * line-number prefix and normalize CRLF — hashPatchBlocks has no equivalent step for either. So
 * two patches differing only in line endings or in that prefix are identical to the applier and
 * still get different dedup keys. [zone-apply-patch-normalization-parity] records one combined
 * payload per apply_patch call that reaches block-level normalization, so all three classes get
 * a denominator (blockCount); smartQuoteChanged no longer indicates an active dedup mismatch —
 * the class it measures is shared now — while the other two fields still do. Nothing here
 * changes parsing, matching, or hashing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;
let logSpy: ReturnType<typeof vi.spyOn>;

function writeRepoFile(filePath: string, content: string): void {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function applyPatch(filePath: string, patch: string) {
  return executeTool(
    "apply_patch",
    { filePath, patch, intent: "modify", scope: null },
    repoPath,
    undefined,
    {}
  );
}

function findNormalizationParityCall() {
  return logSpy.mock.calls.find((c) => c[0] === "[zone-apply-patch-normalization-parity]");
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-norm-parity-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch normalization-parity telemetry", () => {
  it("smart quotes in FIND → smartQuoteChanged true", async () => {
    const filePath = "src/a.js";
    writeRepoFile(filePath, 'const label = "hello";\n');
    const patch =
      "--- FIND ---\n" +
      "const label = “hello”;\n" +
      "--- REPLACE ---\n" +
      'const label = "world";';

    await applyPatch(filePath, patch);

    const call = findNormalizationParityCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.smartQuoteChanged).toBe(true);
  });

  it("CRLF inside a single block → eolChangedBlocks is 1", async () => {
    const filePath = "src/b.js";
    writeRepoFile(filePath, "line1\nline2\n");
    const patch = "--- FIND ---\r\nline1\r\nline2\r\n--- REPLACE ---\r\nline3\r\nline4";

    await applyPatch(filePath, patch);

    const call = findNormalizationParityCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.eolChangedBlocks).toBe(1);
  });

  it("read_file line-number prefix on every line, single block → prefixStrippedBlocks is 1", async () => {
    const filePath = "src/c.js";
    writeRepoFile(filePath, "const a = 1;\nconst b = 2;\n");
    const patch =
      "--- FIND ---\n" +
      "     1\tconst a = 1;\n" +
      "     2\tconst b = 2;\n" +
      "--- REPLACE ---\n" +
      "const a = 9;\n" +
      "const b = 8;";

    await applyPatch(filePath, patch);

    const call = findNormalizationParityCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.prefixStrippedBlocks).toBe(1);
  });

  it("the denominator lock: a clean ASCII/LF patch still emits a fully-specified baseline record", async () => {
    const filePath = "src/d.js";
    writeRepoFile(filePath, "const x = 1;\n");
    const patch = "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;";

    await applyPatch(filePath, patch);

    const call = findNormalizationParityCall();
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.blockCount).toBe(1);
    expect(payload.smartQuoteChanged).toBe(false);
    expect(payload.eolChangedBlocks).toBe(0);
    expect(payload.prefixStrippedBlocks).toBe(0);
  });

  it("a FIND block with a prefix on only some lines → prefixStrippedBlocks stays 0 (tracks stripping, not calling)", async () => {
    const filePath = "src/e.js";
    writeRepoFile(filePath, "const a = 1;\nconst b = 2;\n");
    // Line 1 carries the read_file prefix, line 2 does not — stripReadFilePrefix's
    // all-or-nothing condition fails, so it returns the block unchanged.
    const patch =
      "--- FIND ---\n" +
      "     1\tconst a = 1;\n" +
      "const b = 2;\n" +
      "--- REPLACE ---\n" +
      "const a = 9;\n" +
      "const b = 8;";

    await applyPatch(filePath, patch);

    const call = findNormalizationParityCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.prefixStrippedBlocks).toBe(0);
  });

  it("a \\r only in marker-adjacent padding the walk's own trim discards → eolChangedBlocks stays 0", async () => {
    // The walk's own leading-newline trim strips "\r\n" right after the FIND marker, so
    // block.find never contains the \r at all — it never reaches block-level normalization.
    // Distinguishes "did this call's actual block content change" (correct) from "does the
    // raw patch string contain \r anywhere" (wrong, unscoped) — see mutation 8.
    const filePath = "src/f.js";
    writeRepoFile(filePath, "foo\n");
    const patch = "--- FIND ---\r\nfoo\n--- REPLACE ---\nbar";

    await applyPatch(filePath, patch);

    const call = findNormalizationParityCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.eolChangedBlocks).toBe(0);
  });

  it("CRLF and a read_file prefix in the same block, with a blank line → prefixStrippedBlocks is 1", async () => {
    // The composition probe. stripReadFilePrefix filters blank lines with `l !== ""`; under CRLF
    // a blank line is "\r", survives that filter, fails /^\s*\d+\t/, and aborts the
    // all-or-nothing strip. The match-time path normalizes EOL FIRST and therefore does strip
    // here, so a pre-pass that strips first reports 0 for a block the applier normalizes.
    // Only this fixture co-occurs the two classes — every other one here carries at most one.
    const filePath = "src/g.js";
    writeRepoFile(filePath, "const a = 1;\n\nconst b = 2;\n");
    const patch =
      "--- FIND ---\r\n" +
      "     1\tconst a = 1;\r\n" +
      "\r\n" +
      "     3\tconst b = 2;\r\n" +
      "--- REPLACE ---\n" +
      "const a = 9;\n" +
      "\n" +
      "const b = 8;";

    await applyPatch(filePath, patch);

    const call = findNormalizationParityCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.eolChangedBlocks).toBe(1);
    expect(payload.prefixStrippedBlocks).toBe(1);
  });

  it("CRLF with no prefix, single block → prefixStrippedBlocks stays 0 (both sides of the comparison are normalized)", async () => {
    // Pins that the EOL normalization added for the composition applies to BOTH operands. A
    // one-sided version (normalize the stripped side only) makes every CRLF block compare
    // unequal and count as prefix-stripped. Not the sole discriminator — the three-block
    // fixture below also catches it — but it isolates the property in one block.
    const filePath = "src/h.js";
    writeRepoFile(filePath, "line1\nline2\n");
    const patch = "--- FIND ---\r\nline1\r\nline2\r\n--- REPLACE ---\r\nline3\r\nline4";

    await applyPatch(filePath, patch);

    const call = findNormalizationParityCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.eolChangedBlocks).toBe(1);
    expect(payload.prefixStrippedBlocks).toBe(0);
  });

  it("three blocks, one CRLF-only, one prefix-only, one neither → counts are exactly 1 and 1, read against blockCount", async () => {
    const filePath = "doc.md";
    writeRepoFile(filePath, "unrelated content\n");
    const patch =
      "--- FIND ---\r\n" +
      "alpha1\r\n" +
      "alpha2\r\n" +
      "--- REPLACE ---\n" +
      "ALPHA\n" +
      "--- FIND ---\n" +
      "     1\tbeta\n" +
      "--- REPLACE ---\n" +
      "BETA\n" +
      "--- FIND ---\n" +
      "gamma\n" +
      "--- REPLACE ---\n" +
      "GAMMA";

    await applyPatch(filePath, patch);

    const call = findNormalizationParityCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    // First and alone-in-spirit: the counts below are only interpretable against this.
    expect(payload.blockCount).toBe(3);
    expect(payload.eolChangedBlocks).toBe(1);
    expect(payload.prefixStrippedBlocks).toBe(1);
  });
});
