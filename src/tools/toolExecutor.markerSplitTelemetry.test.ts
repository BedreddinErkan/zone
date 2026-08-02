/**
 * Detection-only telemetry for the KNOWN DEFECT documented above the walk in
 * toolExecutor.ts: an embedded, matched FIND/REPLACE pair inside what should be
 * one block's REPLACE content makes the substring-anywhere walk fabricate an
 * extra block. [zone-apply-patch-marker-split] records every multi-block
 * apply_patch call (not just suspected instances — see the code comment on why
 * gating on the heuristic would be a structural-zero trap). Nothing here changes
 * which patches are accepted, rejected, or how they're parsed.
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

function findMarkerSplitCall() {
  return logSpy.mock.calls.find((c) => c[0] === "[zone-apply-patch-marker-split]");
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-marker-split-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch marker-split telemetry", () => {
  it("A — the silent-write reproduction: fabricated FIND present in file, marker records not-rejected", async () => {
    const filePath = "doc.md";
    writeRepoFile(filePath, "# Docs\n\n## Usage\n\nconst timeout = 30;\n");
    const patch =
      "--- FIND ---\n" +
      "## Usage\n" +
      "--- REPLACE ---\n" +
      "## Usage\n" +
      "\n" +
      "To edit a file, send a patch like this:\n" +
      "\n" +
      "--- FIND ---\n" +
      "const timeout = 30;\n" +
      "--- REPLACE ---\n" +
      "const timeout = 60;\n";

    await applyPatch(filePath, patch);

    const call = findMarkerSplitCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.rejected).toBe(false);
  });

  it("B — the confusing-rejection reproduction: fabricated FIND absent from file, marker records rejected", async () => {
    const filePath = "doc.md";
    writeRepoFile(filePath, "# Docs\n\n## Usage\n\nSee below.\n");
    const patch =
      "--- FIND ---\n" +
      "## Usage\n" +
      "--- REPLACE ---\n" +
      "## Usage\n" +
      "\n" +
      "To edit a file, send a patch like this:\n" +
      "\n" +
      "--- FIND ---\n" +
      "const timeout = 30;\n" +
      "--- REPLACE ---\n" +
      "const timeout = 60;\n";

    await applyPatch(filePath, patch);

    const call = findMarkerSplitCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.rejected).toBe(true);
  });

  it("C — a clean, intentional 2-block patch: marker fires, reports zero content-embedded boundaries", async () => {
    const filePath = "sample.txt";
    writeRepoFile(filePath, "old1\nold2\n");
    const patch =
      "--- FIND ---\n" +
      "old1\n" +
      "--- REPLACE ---\n" +
      "new1\n" +
      "--- FIND ---\n" +
      "old2\n" +
      "--- REPLACE ---\n" +
      "new2\n";

    await applyPatch(filePath, patch);

    const call = findMarkerSplitCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.contentEmbeddedBoundaryCount).toBe(0);
  });

  it("D — a normal single-block patch does not fire the marker", async () => {
    const filePath = "sample.txt";
    writeRepoFile(filePath, "old\n");
    const patch = "--- FIND ---\nold\n--- REPLACE ---\nnew\n";

    await applyPatch(filePath, patch);

    const call = findMarkerSplitCall();
    expect(call).toBeUndefined();
  });

  it("E — blockCount is threaded from the real parse, not a constant", async () => {
    // 4 blocks, 2 blank-line-preceded boundaries (before block 2, before block 4).
    const filePath = "doc.md";
    writeRepoFile(filePath, "unrelated content\n");
    const patch =
      "--- FIND ---\n" +
      "first\n" +
      "--- REPLACE ---\n" +
      "FIRST\n" +
      "\n" +
      "Prose one.\n" +
      "\n" +
      "--- FIND ---\n" +
      "second\n" +
      "--- REPLACE ---\n" +
      "SECOND\n" +
      "--- FIND ---\n" +
      "third\n" +
      "--- REPLACE ---\n" +
      "THIRD\n" +
      "\n" +
      "Prose two.\n" +
      "\n" +
      "--- FIND ---\n" +
      "fourth\n" +
      "--- REPLACE ---\n" +
      "FOURTH\n";

    await applyPatch(filePath, patch);

    const call = findMarkerSplitCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.blockCount).toBe(4);
  });

  it("F — contentEmbeddedBoundaryCount is threaded from the real computation, not a constant", async () => {
    // Same fixture as E — reused because it's the one with a non-trivial, non-Case-A/B value.
    const filePath = "doc.md";
    writeRepoFile(filePath, "unrelated content\n");
    const patch =
      "--- FIND ---\n" +
      "first\n" +
      "--- REPLACE ---\n" +
      "FIRST\n" +
      "\n" +
      "Prose one.\n" +
      "\n" +
      "--- FIND ---\n" +
      "second\n" +
      "--- REPLACE ---\n" +
      "SECOND\n" +
      "--- FIND ---\n" +
      "third\n" +
      "--- REPLACE ---\n" +
      "THIRD\n" +
      "\n" +
      "Prose two.\n" +
      "\n" +
      "--- FIND ---\n" +
      "fourth\n" +
      "--- REPLACE ---\n" +
      "FOURTH\n";

    await applyPatch(filePath, patch);

    const call = findMarkerSplitCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.contentEmbeddedBoundaryCount).toBe(2);
  });

  it("G — findMarkerCount is threaded from the raw text count, not from blocks.length", async () => {
    // Constructed so the walk's own block count (2) diverges from the raw marker
    // count (3): the 2nd FIND has no REPLACE before the 3rd FIND, so the walk
    // absorbs the 3rd FIND into block 2's find content instead of starting a new
    // block. Not a realistic model output — a white-box fixture proving
    // findMarkerCount isn't wired to blocks.length by accident.
    const filePath = "doc.md";
    writeRepoFile(filePath, "unrelated content\n");
    const patch =
      "--- FIND ---\n" +
      "alpha\n" +
      "--- REPLACE ---\n" +
      "ALPHA\n" +
      "--- FIND ---\n" +
      "X\n" +
      "--- FIND ---\n" +
      "Y\n" +
      "--- REPLACE ---\n" +
      "Z\n" +
      "--- REPLACE ---\n";

    await applyPatch(filePath, patch);

    const call = findMarkerSplitCall();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.findMarkerCount).toBe(3);
  });
});
