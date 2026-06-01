import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function multiEdit(
  files: string[],
  find: string,
  replace: string,
  opts: { wholeWord?: boolean | null; stagingFiles?: Map<string, string> } = {}
) {
  return executeTool(
    "multi_edit",
    { files, find, replace, wholeWord: opts.wholeWord ?? null },
    repoPath,
    undefined,
    opts.stagingFiles !== undefined ? { stagingFiles: opts.stagingFiles } : undefined
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-multi-edit-test-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("multi_edit", () => {
  it("basic rename across 3 files (wholeWord=true default)", async () => {
    writeRepoFile("a.ts", "const foo = 1;\nconst bar = foo + foo;\n");
    writeRepoFile("b.ts", "export { foo };\n");
    writeRepoFile("c.ts", "// foo usage\nlet x = foo;\n");

    const staging = new Map<string, string>();
    const result = await multiEdit(["a.ts", "b.ts", "c.ts"], "foo", "baz", { stagingFiles: staging });

    expect(result.success).toBe(true);
    expect(result.output).toContain("6 replacement(s) across 3 file(s)");

    // check staging (not disk) was written
    const absA = path.resolve(repoPath, "a.ts");
    const absB = path.resolve(repoPath, "b.ts");
    const absC = path.resolve(repoPath, "c.ts");
    expect(staging.get(absA)).toContain("baz");
    expect(staging.get(absB)).toContain("baz");
    expect(staging.get(absC)).toContain("baz");
    // disk should be unchanged
    expect(readRepoFile("a.ts")).toContain("foo");
  });

  it("COMPOUND GUARD: bare identifier renamed, compound untouched (wholeWord=true)", async () => {
    writeRepoFile(
      "tokens.ts",
      "const cumulativeTokens = 100;\nconst cumulativeTokensAtManifest = 50;\nreturn cumulativeTokens + 1;\n"
    );

    const staging = new Map<string, string>();
    const result = await multiEdit(
      ["tokens.ts"],
      "cumulativeTokens",
      "effectiveTokens",
      { wholeWord: true, stagingFiles: staging }
    );

    expect(result.success).toBe(true);
    const abs = path.resolve(repoPath, "tokens.ts");
    const written = staging.get(abs)!;
    expect(written).toContain("effectiveTokens");
    expect(written).toContain("cumulativeTokensAtManifest"); // compound unchanged
    expect(written).not.toContain("cumulativeTokens =");    // bare renamed
    expect(written).not.toContain("cumulativeTokens +");    // bare renamed
  });

  it("wholeWord=false performs literal substring replace", async () => {
    writeRepoFile(
      "sub.ts",
      "const cumulativeTokens = 1;\nconst cumulativeTokensAtManifest = 2;\n"
    );

    const staging = new Map<string, string>();
    const result = await multiEdit(
      ["sub.ts"],
      "cumulativeTokens",
      "effectiveTokens",
      { wholeWord: false, stagingFiles: staging }
    );

    expect(result.success).toBe(true);
    const abs = path.resolve(repoPath, "sub.ts");
    const written = staging.get(abs)!;
    // both occurrences replaced (substring match)
    expect(written).toContain("effectiveTokensAtManifest");
    expect(written).not.toContain("cumulativeTokens");
  });

  it("staging-aware: reads prior staged content, not disk", async () => {
    writeRepoFile("staged.ts", "const oldName = 1;\n");
    const abs = path.resolve(repoPath, "staged.ts");

    const staging = new Map<string, string>();
    // Simulate a prior write to staging (not on disk yet)
    staging.set(abs, "const midName = 1;\n");

    const result = await multiEdit(["staged.ts"], "midName", "newName", { stagingFiles: staging });

    expect(result.success).toBe(true);
    expect(staging.get(abs)).toContain("newName");
    expect(staging.get(abs)).not.toContain("midName");
    // disk untouched
    expect(readRepoFile("staged.ts")).toContain("oldName");
  });

  it("file not found: count=-1 in output, others still succeed, success:true", async () => {
    writeRepoFile("exists.ts", "const foo = 1;\n");

    const staging = new Map<string, string>();
    const result = await multiEdit(
      ["exists.ts", "missing.ts"],
      "foo",
      "bar",
      { stagingFiles: staging }
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("[NOT FOUND] missing.ts");
    expect(result.output).toContain("exists.ts: 1 replacement(s)");
  });

  it("find not present: count=0, no staging write, success:true", async () => {
    writeRepoFile("noop.ts", "const unrelated = 42;\n");
    const abs = path.resolve(repoPath, "noop.ts");

    const staging = new Map<string, string>();
    const result = await multiEdit(["noop.ts"], "notPresent", "x", { stagingFiles: staging });

    expect(result.success).toBe(true);
    expect(result.output).toContain('"notPresent" was not found');
    expect(staging.has(abs)).toBe(false); // no write when count=0
  });

  it("empty find string returns error", async () => {
    const result = await multiEdit(["any.ts"], "", "x");
    expect(result.success).toBe(false);
    expect(result.output).toContain("find string must be non-empty");
  });

  it("empty files array returns error", async () => {
    const result = await multiEdit([], "foo", "bar");
    expect(result.success).toBe(false);
    expect(result.output).toContain("files array must be non-empty");
  });
});
