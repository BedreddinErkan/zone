import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
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

  it("fails protected src/ui paths without writing them", async () => {
    const result = await applyLlmPatches(
      [
        {
          filePath: "src/ui/index.html",
          fullContent: "<html><body>bad overwrite</body></html>",
        },
      ],
      tmpDir
    );

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual(["src/ui/index.html"]);
    await expect(fs.access(path.join(tmpDir, "src/ui/index.html"))).rejects.toThrow();
  });
});

/**
 * Item 301: the containment check used to be a lexical `startsWith`,
 * symlink-blind — case 2 below is the exact construction that escaped before
 * the fix and must refuse now. These cases need real symlinks, so they use
 * sync `fs` and their own fixtures rather than the async helpers above.
 */
describe("applyLlmPatches — containment (item 301)", () => {
  let repoDir: string;
  let outsideDir: string;

  beforeEach(() => {
    repoDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "zone-alp-repo-"));
    outsideDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "zone-alp-outside-"));
  });

  afterEach(() => {
    fsSync.rmSync(repoDir, { recursive: true, force: true });
    fsSync.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("HOSTILE INPUT: the exact symlink escape that succeeded before this fix now refuses, and nothing outside the repo changes", async () => {
    fsSync.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    const secret = path.join(outsideDir, "secret.txt");
    fsSync.writeFileSync(secret, "ORIGINAL-OUTSIDE\n", "utf8");
    fsSync.symlinkSync(secret, path.join(repoDir, "src", "link.txt"));

    const res = await applyLlmPatches(
      [{ filePath: "src/link.txt", fullContent: "OVERWRITTEN-VIA-SYMLINK\n" }],
      repoDir
    );

    expect(res.applied).toEqual([]);
    expect(res.failed).toEqual(["src/link.txt"]);
    expect(fsSync.readFileSync(secret, "utf8")).toBe("ORIGINAL-OUTSIDE\n");
  });

  it("asymmetric realpath: a repo root reached through a symlink still allows a legitimate write (X2)", async () => {
    // If only the TARGET were realpathed and the repo root were not, a
    // realpath'd target ("<real>/src/x.ts") would never lexically match an
    // un-realpath'd root ("<symlinked-repo>"), and a legitimate write through
    // a symlinked --repo would be spuriously rejected.
    const symlinkedRepo = path.join(os.tmpdir(), `zone-alp-repolink-${Date.now()}`);
    fsSync.symlinkSync(repoDir, symlinkedRepo);
    try {
      const res = await applyLlmPatches(
        [{ filePath: "src/via-symlinked-root.ts", fullContent: "export const y = 2;\n" }],
        symlinkedRepo
      );
      expect(res.applied).toEqual(["src/via-symlinked-root.ts"]);
      expect(res.failed).toEqual([]);
    } finally {
      fsSync.unlinkSync(symlinkedRepo);
    }
  });

  it("undecidable boundary: a broken symlink target fails closed, not open (X3)", async () => {
    fsSync.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    // Points at a path that does not exist — realpathSync throws, containment
    // cannot be proven, checkPathBoundary's own contract says that means "escape".
    fsSync.symlinkSync(
      path.join(outsideDir, "does-not-exist.txt"),
      path.join(repoDir, "src", "broken.txt")
    );
    const res = await applyLlmPatches(
      [{ filePath: "src/broken.txt", fullContent: "should not land\n" }],
      repoDir
    );
    expect(res.applied).toEqual([]);
    expect(res.failed).toEqual(["src/broken.txt"]);
  });

  it("multi-patch: a legitimate patch followed by an escaping one — only the escaping one fails (X4, direction one)", async () => {
    fsSync.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    const secret = path.join(outsideDir, "secret2.txt");
    fsSync.writeFileSync(secret, "UNTOUCHED\n", "utf8");
    fsSync.symlinkSync(secret, path.join(repoDir, "src", "escape.txt"));

    const res = await applyLlmPatches(
      [
        { filePath: "src/good.ts", fullContent: "export const a = 1;\n" },
        { filePath: "src/escape.txt", fullContent: "SHOULD NOT LAND\n" },
      ],
      repoDir
    );
    expect(res.applied).toEqual(["src/good.ts"]);
    expect(res.failed).toEqual(["src/escape.txt"]);
    expect(fsSync.readFileSync(secret, "utf8")).toBe("UNTOUCHED\n");
  });

  it("multi-patch: an escaping patch followed by a legitimate one — the escape fails and the loop still processes what follows (X4, direction two)", async () => {
    fsSync.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    const secret = path.join(outsideDir, "secret3.txt");
    fsSync.writeFileSync(secret, "UNTOUCHED\n", "utf8");
    fsSync.symlinkSync(secret, path.join(repoDir, "src", "escape2.txt"));

    const res = await applyLlmPatches(
      [
        { filePath: "src/escape2.txt", fullContent: "SHOULD NOT LAND\n" },
        { filePath: "src/good2.ts", fullContent: "export const b = 2;\n" },
      ],
      repoDir
    );
    // If a mutant hoisted the check to only patches[0], this ordering would
    // have caught the escape (patch[0] IS the escape here) but is exactly the
    // shape that would let a THIRD, later patch through unchecked — the
    // companion case above (good-then-escape) is what actually kills that
    // mutant; this case pins that the loop doesn't abort after one failure.
    expect(res.failed).toEqual(["src/escape2.txt"]);
    expect(res.applied).toEqual(["src/good2.ts"]);
    expect(fsSync.readFileSync(secret, "utf8")).toBe("UNTOUCHED\n");
  });
});
