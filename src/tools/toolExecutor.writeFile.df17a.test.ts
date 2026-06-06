/**
 * DF-17a: write_file new-file vs existing-file branching.
 *
 * New files → written directly to disk (immediately visible, survives abort).
 * Existing files → staged (unchanged: atomic/validated/rollback-able).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, withStagingTempFlush } from "./toolExecutor.js";
import { finalizeStaging } from "../llm/agentLoop.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-wf-df17a-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function abs(rel: string): string {
  return path.join(repoPath, rel);
}

describe("DF-17a: write_file new-file vs existing-file", () => {
  it("new file: written directly to disk, NOT added to staging map", async () => {
    const staging = new Map<string, string>();
    const result = await executeTool(
      "write_file",
      { filePath: "src/new.ts", content: "export const x = 1;\n" },
      repoPath,
      undefined,
      { stagingFiles: staging }
    );

    expect(result.success).toBe(true);
    expect(fs.existsSync(abs("src/new.ts"))).toBe(true);
    expect(staging.has(abs("src/new.ts"))).toBe(false);
    expect(fs.readFileSync(abs("src/new.ts"), "utf8")).toBe("export const x = 1;\n");
  });

  it("new file: return message says 'Created'", async () => {
    const result = await executeTool(
      "write_file",
      { filePath: "src/new.ts", content: "export const x = 1;\n" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^Created/);
  });

  it("existing file: still staged, disk content unchanged", async () => {
    const filePath = "src/existing.ts";
    const original = "export const x = 1;\n";
    const updated = "export const x = 2;\n";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(filePath), original, "utf8");

    const staging = new Map<string, string>();
    const result = await executeTool(
      "write_file",
      { filePath, content: updated },
      repoPath,
      undefined,
      { stagingFiles: staging }
    );

    expect(result.success).toBe(true);
    expect(staging.get(abs(filePath))).toBe(updated);
    expect(fs.readFileSync(abs(filePath), "utf8")).toBe(original); // disk unchanged
  });

  it("existing file: return message says 'Staged edit'", async () => {
    const filePath = "src/existing.ts";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(filePath), "const x = 1;\n", "utf8");

    const staging = new Map<string, string>();
    const result = await executeTool(
      "write_file",
      { filePath, content: "const x = 2;\n" },
      repoPath,
      undefined,
      { stagingFiles: staging }
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^Staged edit/);
  });

  it("new file not in staging map: finalizeStaging on empty map completes cleanly, file stays on disk", async () => {
    const staging = new Map<string, string>();
    await executeTool(
      "write_file",
      { filePath: "src/new.ts", content: "export const x = 1;\n" },
      repoPath,
      undefined,
      { stagingFiles: staging }
    );

    // staging is empty — new file went directly to disk
    expect(staging.size).toBe(0);

    // finalizeStaging on empty map should not error and not disturb the new file
    const result = await finalizeStaging({
      stagingFiles: staging,
      repoPath,
      framework: undefined,
      withStagingTempFlush,
    });
    // Nothing to flush
    expect(result.filesFlushed).toBe(0);
    // New file left untouched on disk
    expect(fs.existsSync(abs("src/new.ts"))).toBe(true);
    expect(fs.readFileSync(abs("src/new.ts"), "utf8")).toBe("export const x = 1;\n");
  });

  it("second write to same path is treated as existing (staged)", async () => {
    const staging = new Map<string, string>();
    const opts = { stagingFiles: staging };

    // First write: creates file on disk
    await executeTool(
      "write_file",
      { filePath: "src/file.ts", content: "const a = 1;\n" },
      repoPath,
      undefined,
      opts
    );
    expect(fs.existsSync(abs("src/file.ts"))).toBe(true);
    expect(staging.has(abs("src/file.ts"))).toBe(false);

    // Second write: file now exists → staged, disk unchanged
    await executeTool(
      "write_file",
      { filePath: "src/file.ts", content: "const a = 2;\n" },
      repoPath,
      undefined,
      opts
    );
    expect(staging.get(abs("src/file.ts"))).toBe("const a = 2;\n");
    expect(fs.readFileSync(abs("src/file.ts"), "utf8")).toBe("const a = 1;\n");
  });

  it("new file with syntax error: write fails and file is cleaned up from disk", async () => {
    const brokenTs = "export const broken = {\n  // unclosed brace";
    const result = await executeTool(
      "write_file",
      { filePath: "src/broken.ts", content: brokenTs },
      repoPath
    );
    expect(result.success).toBe(false);
    // File must NOT be left dangling on disk after a failed new-file write
    expect(fs.existsSync(abs("src/broken.ts"))).toBe(false);
  });
});
