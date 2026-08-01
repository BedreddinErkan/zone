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

function readRepoFile(filePath: string): string {
  return fs.readFileSync(path.join(repoPath, filePath), "utf8");
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
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-marker-balance-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch marker balance pre-flight", () => {
  it("rejects 1 FIND / 2 REPLACE shape with marker_imbalance error", async () => {
    const filePath = "sample.txt";
    const original = "old line\nanother old line\n";
    writeRepoFile(filePath, original);
    const patch =
      "--- FIND ---\n" +
      "old line\n" +
      "--- REPLACE ---\n" +
      "new line\n" +
      "another old line\n" +
      "--- REPLACE ---\n" +
      "another new line\n";

    const result = await applyPatch(filePath, patch);

    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_marker_imbalance");
    expect(result.output).toContain("marker(s)");
    expect(result.output).toContain("balanced");
    expect(result.output).toContain("<second region from file>");
    expect(readRepoFile(filePath)).toBe(original);

    // Found by exact tag match, not a substring scan — the tag is confirmed unique in the
    // codebase, so only this call site can produce it.
    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-apply-patch-marker-imbalance]");
    // The marker firing at all IS the debugLog->log assertion: production only reaches
    // console.log via the unconditional log() path now. A revert to debugLog leaves this
    // undefined, since VERBOSE is unset in the test environment.
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.findMarkerCount).toBe(1);
    expect(payload.replaceMarkerCount).toBe(2);
    expect(payload.filePath).toBe(filePath);
    // Computed independently from the same literal patch, not hardcoded — a future edit to
    // the fixture can't silently desync this assertion from what it's actually checking.
    expect(payload.patchBytes).toBe(Buffer.byteLength(patch, "utf8"));
  });

  it("accepts balanced 2 FIND / 2 REPLACE multi-block patch", async () => {
    const filePath = "sample.txt";
    writeRepoFile(filePath, "first old\nmiddle\nsecond old\n");
    const patch =
      "--- FIND ---\n" +
      "first old\n" +
      "--- REPLACE ---\n" +
      "first new\n" +
      "--- FIND ---\n" +
      "second old\n" +
      "--- REPLACE ---\n" +
      "second new\n";

    const result = await applyPatch(filePath, patch);

    expect(result.error).not.toBe("apply_patch_marker_imbalance");
    expect(result.success).toBe(true);
    expect(readRepoFile(filePath)).toBe("first new\nmiddle\nsecond new\n");
  });

  it("accepts standard 1 FIND / 1 REPLACE patch", async () => {
    const filePath = "sample.txt";
    writeRepoFile(filePath, "old\n");
    const patch =
      "--- FIND ---\n" +
      "old\n" +
      "--- REPLACE ---\n" +
      "new\n";

    const result = await applyPatch(filePath, patch);

    expect(result.error).not.toBe("apply_patch_marker_imbalance");
    expect(result.success).toBe(true);
    expect(readRepoFile(filePath)).toBe("new\n");
  });
});
