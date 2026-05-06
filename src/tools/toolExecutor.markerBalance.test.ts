import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(
      logSpy.mock.calls.filter(
        ([message]) => message === "[zone-apply-patch-marker-imbalance]"
      )
    ).toHaveLength(1);
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
