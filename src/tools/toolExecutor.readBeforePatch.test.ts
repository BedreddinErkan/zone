/**
 * Phase V Commit 1: read-before-patch enforcement.
 * When filesReadThisRun is provided, apply_patch requires the target path
 * to be present in the set before proceeding.
 */

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

async function applyPatch(
  filePath: string,
  patch: string,
  filesReadThisRun?: ReadonlySet<string>
) {
  return executeTool(
    "apply_patch",
    { filePath, patch, intent: "modify", scope: null },
    repoPath,
    undefined,
    { filesReadThisRun }
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-rbp-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("read-before-patch enforcement", () => {
  it("approves apply_patch when filesReadThisRun is not provided (backward compat)", async () => {
    writeRepoFile("src/foo.ts", "const x = 1;\n");
    const result = await applyPatch(
      "src/foo.ts",
      "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
      undefined
    );
    expect(result.success).toBe(true);
  });

  it("approves apply_patch when file is in filesReadThisRun", async () => {
    writeRepoFile("src/foo.ts", "const x = 1;\n");
    const result = await applyPatch(
      "src/foo.ts",
      "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
      new Set(["src/foo.ts"])
    );
    expect(result.success).toBe(true);
  });

  it("rejects apply_patch with READ_REQUIRED when filesReadThisRun is empty", async () => {
    writeRepoFile("src/foo.ts", "const x = 1;\n");
    const result = await applyPatch(
      "src/foo.ts",
      "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
      new Set()
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_no_read_first");
    expect(result.output).toMatch(/READ_REQUIRED/);
    expect(result.output).toContain("src/foo.ts");
  });

  it("approves after failed read is NOT in set but successful read IS added", async () => {
    // The set only contains paths from successful reads.
    // A failed read never adds to the set; a successful read does.
    writeRepoFile("src/foo.ts", "const x = 1;\n");
    const setWithSuccessRead = new Set(["src/foo.ts"]);
    const result = await applyPatch(
      "src/foo.ts",
      "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
      setWithSuccessRead
    );
    expect(result.success).toBe(true);
  });

  it("rejects when a different filePath was read but not the target", async () => {
    writeRepoFile("src/foo.ts", "const x = 1;\n");
    // "src/other.ts" was read, but we're patching "src/foo.ts"
    const result = await applyPatch(
      "src/foo.ts",
      "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
      new Set(["src/other.ts"])
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_no_read_first");
    expect(result.output).toMatch(/READ_REQUIRED/);
  });

  it("search_in_files does NOT satisfy read requirement (set must be built by read_file)", async () => {
    // Simulates: agent ran search_in_files on foo.ts but never read_file'd it.
    // The filesReadThisRun set only grows from read_file/write_file/apply_patch,
    // so search_in_files results are never added. Empty set = not satisfied.
    writeRepoFile("src/foo.ts", "const x = 1;\n");
    const result = await applyPatch(
      "src/foo.ts",
      "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
      new Set() // search_in_files never populates this
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("apply_patch_no_read_first");
  });
});
