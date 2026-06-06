import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DENYLIST_DIRS,
  denylistGlobs,
  ripgrepDenylistGlob,
  gitignoreGlobs,
  buildFastGlobIgnore,
} from "./searchIgnore.js";

describe("searchIgnore — hard denylist", () => {
  it("covers VCS + build-output dirs the agent must never ingest", () => {
    for (const d of [".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo"]) {
      expect(DENYLIST_DIRS).toContain(d);
    }
  });

  it("denylistGlobs returns **/<dir>/** fast-glob patterns", () => {
    const g = denylistGlobs();
    expect(g).toContain("**/.next/**");
    expect(g).toContain("**/node_modules/**");
    expect(g).toContain("**/build/**");
  });

  it("ripgrepDenylistGlob is a single negated brace glob", () => {
    const g = ripgrepDenylistGlob();
    expect(g.startsWith("!**/{")).toBe(true);
    expect(g.endsWith("}/**")).toBe(true);
    expect(g).toContain(".next");
    expect(g).toContain("node_modules");
  });
});

describe("searchIgnore — gitignoreGlobs", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-gi-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] when there is no .gitignore", () => {
    expect(gitignoreGlobs(dir)).toEqual([]);
  });

  it("translates plain dir/path entries and skips comments, negations, and globs", () => {
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      ["# a comment", "node_modules", "dist/", "/build", "!keep-me", "*.log", ""].join("\n"),
    );
    const g = gitignoreGlobs(dir);
    expect(g).toContain("**/node_modules/**");
    expect(g).toContain("**/dist/**");
    expect(g).toContain("**/build/**");
    // negation + wildcard entries are intentionally not translated
    expect(g.some((x) => x.includes("keep-me"))).toBe(false);
    expect(g.some((x) => x.includes("log"))).toBe(false);
  });
});

describe("searchIgnore — buildFastGlobIgnore", () => {
  it("returns [] under the escape hatch (include everything)", () => {
    expect(buildFastGlobIgnore("/nonexistent", true)).toEqual([]);
  });

  it("includes the denylist by default", () => {
    const ig = buildFastGlobIgnore("/nonexistent", false);
    expect(ig).toContain("**/.next/**");
    expect(ig).toContain("**/coverage/**");
  });
});
