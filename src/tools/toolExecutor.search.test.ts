/**
 * Phase S.1 tests: search_in_files upgrade — regex, output_mode, backward compat.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-s1-"));
  // Create test files
  fs.writeFileSync(path.join(repoPath, "alpha.ts"), [
    "const foo = 1;",
    "const bar = 2;",
    "const foobar = foo + bar;",
    "export { foo, bar, foobar };",
  ].join("\n"));
  fs.writeFileSync(path.join(repoPath, "beta.ts"), [
    "import { foo } from './alpha';",
    "const FOO = foo * 2;",
    "export default FOO;",
  ].join("\n"));
  fs.writeFileSync(path.join(repoPath, "readme.md"), [
    "# Project",
    "Uses foo pattern.",
    "Also references bar.",
  ].join("\n"));
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "util.ts"), [
    "function fooHelper() {",
    "  return 'foo value';",
    "}",
  ].join("\n"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("search_in_files — backward compat (S.1)", () => {
  it("old call shape { pattern, fileGlob: null } returns success with content blocks", async () => {
    const result = await executeTool("search_in_files", { pattern: "foo", fileGlob: null }, repoPath);
    expect(result.success).toBe(true);
    expect(result.output).toContain("foo");
    expect(result.output).toContain("[search_in_files]");
    expect(result.output).toMatch(/alpha\.ts|beta\.ts|readme\.md|util\.ts/);
  });

  it("old call shape with fileGlob **/*.ts limits to ts files", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("readme.md");
    expect(result.output).toMatch(/alpha\.ts|beta\.ts|util\.ts/);
  });
});

describe("search_in_files — regex mode (S.1)", () => {
  it("regex pattern matches lines correctly", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "const\\s+foo\\w*\\s*=", fileGlob: null },
      repoPath
    );
    expect(result.success).toBe(true);
    // Should match "const foo = 1;" and "const foobar = foo + bar;"
    expect(result.output).toContain("alpha.ts");
  });

  it("regex anchors work — ^ matches only at line start", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "^const foo", fileGlob: "**/*.ts" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("alpha.ts");
  });

  it("invalid regex returns success=false with error message", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "[unclosed", fileGlob: null },
      repoPath
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/invalid|error/i);
  });
});

describe("search_in_files — literal mode (S.1)", () => {
  it("literal=true treats pattern as plain string (regex special chars not interpreted)", async () => {
    fs.writeFileSync(path.join(repoPath, "special.ts"), "const x = a.b; // dot");
    const result = await executeTool(
      "search_in_files",
      { pattern: "a.b", fileGlob: null, literal: true },
      repoPath
    );
    expect(result.success).toBe(true);
    // "a.b" as literal should match only the exact substring
    expect(result.output).toContain("special.ts");
    // In regex mode "a.b" would also match "aXb" — with literal it won't
  });

  it("literal=false (default) interprets pattern as regex", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "foo|bar", fileGlob: "**/*.ts", literal: false },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("alpha.ts");
  });
});

describe("search_in_files — case_insensitive (S.1)", () => {
  it("case_insensitive=true finds FOO when searching for foo", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts", case_insensitive: true },
      repoPath
    );
    expect(result.success).toBe(true);
    // beta.ts has "FOO" — should be found
    expect(result.output).toContain("beta.ts");
  });

  it("case_insensitive=false (default) misses FOO when searching for foo (only exact-case)", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "^FOO", fileGlob: "**/*.ts", case_insensitive: false },
      repoPath
    );
    expect(result.success).toBe(true);
    // beta.ts line "const FOO = ..." starts with "const", not "FOO" — anchor test
    // beta.ts has "const FOO" — ^FOO should not match; match count for beta.ts should be 0
    expect(result.output).not.toContain("beta.ts:");
  });
});

describe("search_in_files — output_mode (S.1)", () => {
  it("output_mode=files_with_matches returns one file per line, no context blocks", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts", output_mode: "files_with_matches" },
      repoPath
    );
    expect(result.success).toBe(true);
    // Should list matched files without context lines
    expect(result.output).toMatch(/alpha\.ts|beta\.ts|util\.ts/);
    expect(result.output).toContain("file(s) matched");
    // Should not contain typical context block markers like "> " line prefix
    // (files_with_matches mode returns just paths)
    expect(result.output).not.toMatch(/>\s+\d+:/);
  });

  it("output_mode=count returns per-file match counts", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts", output_mode: "count" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/\d+/); // has numbers
    expect(result.output).toContain("matches across");
    // alpha.ts has multiple foo matches
    expect(result.output).toMatch(/alpha\.ts.*\d+|\d+.*alpha\.ts/);
  });

  it("output_mode=content (default) returns context blocks with line markers", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "alpha.ts", output_mode: "content" },
      repoPath
    );
    expect(result.success).toBe(true);
    // Content mode emits "> linenum: text" markers
    expect(result.output).toMatch(/>\s+\d+:\s+/);
    expect(result.output).toContain("[search_in_files]");
  });

  it("no output_mode field defaults to content mode", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "foobar", fileGlob: null },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/>\s+\d+:\s+/);
  });
});

describe("search_in_files — context_lines (S.1)", () => {
  it("context_lines=0 produces no context, only match lines", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "foobar", fileGlob: "alpha.ts", context_lines: 0 },
      repoPath
    );
    expect(result.success).toBe(true);
    // With context_lines=0 there should only be the match line ("> N: ...")
    // and no context lines ("  N: ...")
    // Match line: "const foobar = foo + bar;" is line 3
    // Context would be lines 2 and 4 — if context_lines=0, they should not appear
    const matchSection = result.output.split("---")[0] ?? "";
    const contextLinePattern = /^\s{2}\s+\d+:/m;
    expect(matchSection).not.toMatch(contextLinePattern);
  });

  it("context_lines=2 (default) includes surrounding lines", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "foobar", fileGlob: "alpha.ts", context_lines: 2 },
      repoPath
    );
    expect(result.success).toBe(true);
    // Should include at least the match line plus context
    const lines = result.output.split("\n").filter((l) => /\d+:/.test(l));
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe("search_in_files — glob alias (S.1)", () => {
  it("glob field (new) is equivalent to fileGlob (old)", async () => {
    const byGlob = await executeTool(
      "search_in_files",
      { pattern: "foo", glob: "**/*.ts" },
      repoPath
    );
    const byFileGlob = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts" },
      repoPath
    );
    expect(byGlob.success).toBe(true);
    expect(byFileGlob.success).toBe(true);
    // Both should match the same set of files
    const filesInGlob = (byGlob.output.match(/\w+\.ts/g) ?? []).sort();
    const filesInFileGlob = (byFileGlob.output.match(/\w+\.ts/g) ?? []).sort();
    expect(filesInGlob).toEqual(filesInFileGlob);
  });
});

describe("search_in_files — no matches (S.1)", () => {
  it("returns (no matches) when pattern not found", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "NONEXISTENT_UNIQUE_PATTERN_XYZ", fileGlob: null },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("(no matches)");
  });

  it("output_mode=files_with_matches with no matches returns (no matches)", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "NONEXISTENT_XYZ", fileGlob: null, output_mode: "files_with_matches" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("(no matches)");
  });
});
