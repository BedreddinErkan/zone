import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyLlmPatches } from "./applyLlmPatches.js";

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

  it("writes normal shallow files correctly", async () => {
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

  it("applies nested file paths inside repo", async () => {
    const content = "public class LoginSteps {}\n";

    const result = await applyLlmPatches(
      [
        {
          filePath:
            "src/test/java/com/enuygun/stepdefinitions/LoginSteps.java",
          fullContent: content,
        },
      ],
      tmpDir
    );

    expect(result.applied).toEqual([
      "src/test/java/com/enuygun/stepdefinitions/LoginSteps.java",
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(
      await readFile(
        "src/test/java/com/enuygun/stepdefinitions/LoginSteps.java"
      )
    ).toBe(content);
  });

  it("creates missing parent directories recursively", async () => {
    const content = "describe('login', () => {});\n";

    const result = await applyLlmPatches(
      [
        {
          filePath: "cypress/e2e/smoke/login.spec.js",
          fullContent: content,
        },
      ],
      tmpDir
    );

    expect(result.applied).toEqual(["cypress/e2e/smoke/login.spec.js"]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(await readFile("cypress/e2e/smoke/login.spec.js")).toBe(content);
  });

  it("overwrites an existing file with new content", async () => {
    await writeExisting("src/util.ts", "// old content\n");
    const newContent = "export function util() {}\n";

    const result = await applyLlmPatches(
      [{ filePath: "src/util.ts", fullContent: newContent }],
      tmpDir
    );

    expect(result.applied).toEqual(["src/util.ts"]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(await readFile("src/util.ts")).toBe(newContent);
  });

  it("fails when patch path escapes repo using dot dot segments", async () => {
    const result = await applyLlmPatches(
      [{ filePath: "../outside.ts", fullContent: "export const x = 1;\n" }],
      tmpDir
    );

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual(["../outside.ts"]);
  });

  it("fails when an absolute path escapes outside the repo", async () => {
    const outsidePath = path.resolve(tmpDir, "..", "outside.ts");

    const result = await applyLlmPatches(
      [{ filePath: outsidePath, fullContent: "export const x = 1;\n" }],
      tmpDir
    );

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([outsidePath]);
  });

  it("fails when repo path does not exist", async () => {
    const badRepoPath = path.join(tmpDir, "does-not-exist");

    const result = await applyLlmPatches(
      [{ filePath: "src/a.ts", fullContent: "const a = 1;" }],
      badRepoPath
    );

    expect(result.failed).toEqual(["src/a.ts"]);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("skips empty content patches even when repo path does not exist", async () => {
    const badRepoPath = path.join(tmpDir, "missing-repo");

    const result = await applyLlmPatches(
      [
        { filePath: "empty.ts", fullContent: "" },
        { filePath: "nested/file.ts", fullContent: "export const x = 1;\n" },
      ],
      badRepoPath
    );

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["empty.ts"]);
    expect(result.failed).toEqual(["nested/file.ts"]);
  });

  it("processes multiple patches independently", async () => {
    const goodContent = "export const good = true;\n";
    const result = await applyLlmPatches(
      [
        { filePath: "src/good.ts", fullContent: goodContent },
        { filePath: "../outside.ts", fullContent: "export const bad = true;\n" },
        { filePath: "src/empty.ts", fullContent: "" },
      ],
      tmpDir
    );

    expect(result.applied).toEqual(["src/good.ts"]);
    expect(result.skipped).toEqual(["src/empty.ts"]);
    expect(result.failed).toEqual(["../outside.ts"]);
    expect(await readFile("src/good.ts")).toBe(goodContent);
  });

  it("does not throw when all patches fail and returns failed array instead", async () => {
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

  it("applied file content is written in utf8", async () => {
    const unicodeContent = "// hello\nexport const greeting = 'world';\n";

    await applyLlmPatches(
      [{ filePath: "unicode.ts", fullContent: unicodeContent }],
      tmpDir
    );

    const written = await readFile("unicode.ts");
    expect(written).toBe(unicodeContent);
  });
});
