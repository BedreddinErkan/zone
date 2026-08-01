/**
 * [zone-apply-patch-marker-imbalance]'s line-anchored recount: a second,
 * stricter count alongside the existing substring counts, so a false
 * positive (marker-looking text inside real patch content) becomes
 * distinguishable from a genuine model formatting error in the record.
 *
 * This distinguishes only the mid-line/quoted case (test B) — an embedded
 * marker genuinely alone on its own line (test E) satisfies the line-anchored
 * count exactly as readily as a real marker and stays indistinguishable.
 * Not a complete fix for P1; see the comment at the emission site.
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

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-marker-line-anchor-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch marker-imbalance — line-anchored recount", () => {
  it("A — a genuine imbalance: substring and line-anchored counts agree", async () => {
    const filePath = "sample.txt";
    writeRepoFile(filePath, "old A\nold B\n");
    const patch =
      "--- FIND ---\n" +
      "old A\n" +
      "--- FIND ---\n" +
      "old B\n" +
      "--- REPLACE ---\n" +
      "new B\n";

    await applyPatch(filePath, patch);

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-apply-patch-marker-imbalance]");
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.findMarkerCountLineAnchored).toBe(payload.findMarkerCount);
    expect(payload.replaceMarkerCountLineAnchored).toBe(payload.replaceMarkerCount);
  });

  it("B — a false positive: line-anchored and substring counts disagree on the embedded marker", async () => {
    const filePath = "sample.txt";
    writeRepoFile(filePath, "old code\n");
    const patch =
      "--- FIND ---\n" +
      "old code\n" +
      "--- REPLACE ---\n" +
      "// Example: \"--- FIND ---\" marks the start of a search region\n" +
      "new code\n";

    await applyPatch(filePath, patch);

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-apply-patch-marker-imbalance]");
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.findMarkerCountLineAnchored).toBe(1);
    expect(payload.findMarkerCount).toBe(2);
    expect(payload.replaceMarkerCountLineAnchored).toBe(1);
    expect(payload.replaceMarkerCount).toBe(1);
  });

  it("C — existing payload fields are unchanged", async () => {
    const filePath = "sample.txt";
    writeRepoFile(filePath, "old A\nold B\n");
    const patch =
      "--- FIND ---\n" +
      "old A\n" +
      "--- FIND ---\n" +
      "old B\n" +
      "--- REPLACE ---\n" +
      "new B\n";

    await applyPatch(filePath, patch);

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-apply-patch-marker-imbalance]");
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.filePath).toBe(filePath);
    expect(payload.patchBytes).toBe(Buffer.byteLength(patch, "utf8"));
    expect(payload.rejected).toBe(true);
  });

  it("D — the rejection decision and message are unchanged", async () => {
    const filePath = "sample.txt";
    writeRepoFile(filePath, "old A\nold B\n");
    const patch =
      "--- FIND ---\n" +
      "old A\n" +
      "--- FIND ---\n" +
      "old B\n" +
      "--- REPLACE ---\n" +
      "new B\n";

    const result = await applyPatch(filePath, patch);

    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_marker_imbalance");
    expect(result.output).toContain("marker(s)");
  });

  it("E — LIMITATION: an unquoted, own-line embedded marker is NOT distinguished (P1 not closed)", async () => {
    // The harder, realistic P1 case: a doc/example block renders "--- FIND ---" as its own
    // line, unquoted — indistinguishable from a real marker by line-content alone. Both pairs
    // agree here; this is the false-positive class this pass does NOT detect.
    const filePath = "sample.txt";
    writeRepoFile(filePath, "old code\n");
    const patch =
      "--- FIND ---\n" +
      "old code\n" +
      "--- REPLACE ---\n" +
      "Example of the patch format:\n" +
      "--- FIND ---\n" +
      "new code\n";

    await applyPatch(filePath, patch);

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-apply-patch-marker-imbalance]");
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.findMarkerCountLineAnchored).toBe(payload.findMarkerCount);
    expect(payload.replaceMarkerCountLineAnchored).toBe(payload.replaceMarkerCount);
  });
});
