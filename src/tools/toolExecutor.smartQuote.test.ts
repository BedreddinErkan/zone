/**
 * Phase V Commit 2: smart-quote auto-fix in FIND/REPLACE blocks.
 * Unicode curly quotes (“”‘’) are silently
 * normalized to ASCII before FIND matching.
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

function readRepoFile(filePath: string): string {
  return fs.readFileSync(path.join(repoPath, filePath), "utf8");
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-sq-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("smart-quote auto-fix", () => {
  it("fixes smart double-quotes in FIND block so match succeeds", async () => {
    // File uses ASCII quotes; FIND block has Unicode curly quotes → auto-fixed
    const original = 'const label = "hello";\n';
    writeRepoFile("src/a.js", original);

    // “hello” are curly double quotes around hello
    const curlyfind = "const label = “hello”;";
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/a.js",
        patch: `--- FIND ---\n${curlyfind}\n--- REPLACE ---\nconst label = "world";`,
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    expect(result.success).toBe(true);
    expect(readRepoFile("src/a.js")).toContain('"world"');
  });

  it("fixes smart double-quotes in REPLACE block before write", async () => {
    const original = 'const x = "old";\n';
    writeRepoFile("src/b.js", original);

    // FIND is correct ASCII; REPLACE has curly quotes — they get normalized
    const curlyReplace = "const x = “new”;";
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/b.js",
        patch: `--- FIND ---\nconst x = "old";\n--- REPLACE ---\n${curlyReplace}`,
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    expect(result.success).toBe(true);
    // Resulting file should have ASCII double-quotes, not curly ones
    const written = readRepoFile("src/b.js");
    expect(written).toContain('"new"');
    expect(written).not.toContain("“");
    expect(written).not.toContain("”");
  });

  it("no-op when no smart quotes present — normal flow unaffected", async () => {
    const original = "const y = 42;\n";
    writeRepoFile("src/c.js", original);
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/c.js",
        patch: "--- FIND ---\nconst y = 42;\n--- REPLACE ---\nconst y = 99;",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    expect(result.success).toBe(true);
    expect(readRepoFile("src/c.js")).toContain("99");
  });

  it("normalizes mixed smart and ASCII quotes — all fixed to ASCII", async () => {
    // File has ASCII single quotes; FIND has a mix of curly and ASCII single-quotes
    const original = "const s = 'foo';\n";
    writeRepoFile("src/d.js", original);

    // ‘foo’ are left/right single curly quotes
    const mixedFind = "const s = ‘foo’;";
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/d.js",
        patch: `--- FIND ---\n${mixedFind}\n--- REPLACE ---\nconst s = 'bar';`,
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    expect(result.success).toBe(true);
    expect(readRepoFile("src/d.js")).toContain("'bar'");
  });
});
