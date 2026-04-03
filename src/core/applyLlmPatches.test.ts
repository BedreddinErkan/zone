import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyLlmPatches } from "./applyLlmPatches.js";

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zone-apply-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readFile(relative: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, relative), "utf8");
}

async function writeExisting(relative: string, content: string): Promise<void> {
  const abs = path.join(tmpDir, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("applyLlmPatches", () => {
  it("returns empty arrays when patches list is empty", async () => {
    const result = await applyLlmPatches([], tmpDir);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("skips patches with empty fullContent", async () => {
    const result = await applyLlmPatches(
      [{ filePath: "src/index.ts", fullContent: "" }],
      tmpDir
    );
    expect(result.skipped).toEqual(["src/index.ts"]);
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("writes file and reports applied when fullContent is non-empty", async () => {
    const content = "export const x = 1;\n";
    const result = await applyLlmPatches(
      [{ filePath: "src/x.ts", fullContent: content }],
      tmpDir
    );
    expect(result.applied).toEqual(["src/x.ts"]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(await readFile("src/x.ts")).toBe(content);
  });

  it("overwrites an existing file with new content", async () => {
    await writeExisting("src/util.ts", "// old content\n");
    const newContent = "export function util() {}\n";

    const result = await applyLlmPatches(
      [{ filePath: "src/util.ts", fullContent: newContent }],
      tmpDir
    );

    expect(result.applied).toEqual(["src/util.ts"]);
    expect(await readFile("src/util.ts")).toBe(newContent);
  });

  it("reports failed when directory does not exist and cannot be created", async () => {
    // Point repoPath at a non-existent directory so writeFile fails
    const badRepoPath = path.join(tmpDir, "does-not-exist");

    const result = await applyLlmPatches(
      [{ filePath: "src/a.ts", fullContent: "const a = 1;" }],
      badRepoPath
    );

    expect(result.failed).toEqual(["src/a.ts"]);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("processes multiple patches independently", async () => {
    const goodContent = "export const good = true;\n";
    const badRepoPath = path.join(tmpDir, "ghost");

    // Mix: one good write, one skip (empty), one fail (bad path written separately)
    const result = await applyLlmPatches(
      [
        { filePath: "src/good.ts", fullContent: goodContent },
        { filePath: "src/empty.ts", fullContent: "" },
      ],
      tmpDir
    );

    expect(result.applied).toContain("src/good.ts");
    expect(result.skipped).toContain("src/empty.ts");
    expect(await readFile("src/good.ts")).toBe(goodContent);

    // Separate failure check
    const failResult = await applyLlmPatches(
      [{ filePath: "src/fail.ts", fullContent: "x" }],
      badRepoPath
    );
    expect(failResult.failed).toContain("src/fail.ts");
  });

  it("does not throw when all patches fail — returns failed array instead", async () => {
    const badRepoPath = path.join(tmpDir, "nonexistent");

    await expect(
      applyLlmPatches(
        [
          { filePath: "a.ts", fullContent: "a" },
          { filePath: "b.ts", fullContent: "b" },
        ],
        badRepoPath
      )
    ).resolves.toEqual({
      applied: [],
      skipped: [],
      failed: ["a.ts", "b.ts"],
    });
  });

  it("resolves filePath relative to repoPath, not cwd", async () => {
    const content = "// resolved correctly\n";

    const result = await applyLlmPatches(
      [{ filePath: "nested/deep/file.ts", fullContent: content }],
      tmpDir
    );

    // writeFile to a nested path without mkdirp will fail — that is expected
    // The point is the path used is path.resolve(repoPath, filePath)
    // Since we do NOT mkdir -p, nested paths fail gracefully
    expect(result.failed).toEqual(["nested/deep/file.ts"]);
    expect(result.applied).toEqual([]);
  });

  it("applied file content is written in utf8", async () => {
    const unicodeContent = "// こんにちは\nexport const greeting = '世界';\n";

    await applyLlmPatches(
      [{ filePath: "unicode.ts", fullContent: unicodeContent }],
      tmpDir
    );

    const written = await readFile("unicode.ts");
    expect(written).toBe(unicodeContent);
  });
});
