/**
 * apply_patch's pre-patch read failure: ENOENT keeps its existing message
 * verbatim; anything else surfaces the real error instead of a generic
 * "File not found" (toolExecutor.ts's read-failure catch used to swallow it).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

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
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-apf-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch — pre-patch read failure", () => {
  it("keeps the ENOENT message exactly unchanged", async () => {
    const result = await applyPatch("src/missing.ts", "--- FIND ---\nx\n--- REPLACE ---\ny");
    expect(result.success).toBe(false);
    expect(result.output).toBe("File not found: src/missing.ts. Use write_file to create new files.");
  });

  it("surfaces the real error for a non-ENOENT failure (EISDIR), no stack, no truncation", async () => {
    const dirPath = "src/notafile";
    fs.mkdirSync(path.join(repoPath, dirPath), { recursive: true });

    const result = await applyPatch(dirPath, "--- FIND ---\nx\n--- REPLACE ---\ny");
    expect(result.success).toBe(false);
    expect(result.output).toContain("EISDIR");
    expect(result.output).not.toBe("File not found: src/notafile. Use write_file to create new files.");
    expect(result.output).not.toMatch(/\n\s*at /);
    expect(result.output.endsWith("…")).toBe(false);
  });

  it("truncates a very long non-ENOENT message with a visible trailing ellipsis", async () => {
    const segments = Array.from({ length: 20 }, (_, i) => `verylongdirectorysegmentnumber${i}`);
    const longDirPath = path.join("src", ...segments);
    fs.mkdirSync(path.join(repoPath, longDirPath), { recursive: true });

    const result = await applyPatch(longDirPath, "--- FIND ---\nx\n--- REPLACE ---\ny");
    expect(result.success).toBe(false);
    expect(result.output).toHaveLength(301);
    expect(result.output.endsWith("…")).toBe(true);
  });
});
