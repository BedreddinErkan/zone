/**
 * Finding 1: the agent-facing file-search tools must not ingest VCS/build
 * directories (e.g. a grep match inside apps/web/.next/server/chunks/679.js).
 * These tests assert (a) a match inside an ignored dir is excluded by default
 * and (b) the include_ignored escape hatch still reaches into them.
 *
 * Deterministic regardless of whether ripgrep is installed: the outcome (which
 * files are matched/listed) holds for both the rg and the fast-glob fallback.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;
const TERM = "NEEDLE_TOKEN";

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-ignore-"));
  // a real source file with the term
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "app.ts"), `export const ${TERM} = 1;\n`);
  // build/ — non-dot build output, NOT excluded by fast-glob's dot:false nor by
  // ripgrep defaults (no .gitignore here): proves the hard denylist does work.
  fs.mkdirSync(path.join(repoPath, "build"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "build", "bundle.js"), `var ${TERM}=1;/*min*/\n`);
  // .next/ — the reported repro (dot dir, minified chunk)
  fs.mkdirSync(path.join(repoPath, ".next", "server", "chunks"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, ".next", "server", "chunks", "679.js"), `const ${TERM}=1;\n`);
  // node_modules/ — non-dot, only excluded by the denylist when un-gitignored
  fs.mkdirSync(path.join(repoPath, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "node_modules", "pkg", "index.js"), `${TERM}\n`);
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("search_in_files — denylist + escape hatch", () => {
  it("excludes build/.next/node_modules by default", async () => {
    const r = await executeTool(
      "search_in_files",
      { pattern: TERM, fileGlob: null, output_mode: "files_with_matches" },
      repoPath,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain("src/app.ts");
    expect(r.output).not.toMatch(/build\/bundle\.js/);
    expect(r.output).not.toMatch(/\.next|679\.js/);
    expect(r.output).not.toMatch(/node_modules/);
  });

  it("reaches into ignored dirs when include_ignored=true", async () => {
    const r = await executeTool(
      "search_in_files",
      { pattern: TERM, fileGlob: null, output_mode: "files_with_matches", include_ignored: true },
      repoPath,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain("build/bundle.js");
    expect(r.output).toMatch(/\.next|679\.js/);
    expect(r.output).toMatch(/node_modules/);
  });
});

describe("list_files — denylist + escape hatch", () => {
  it("excludes build/node_modules by default", async () => {
    const r = await executeTool(
      "list_files",
      { dirPath: ".", pattern: null, include_ignored: null },
      repoPath,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain("src/app.ts");
    expect(r.output).not.toMatch(/build\/bundle\.js/);
    expect(r.output).not.toMatch(/node_modules/);
  });

  it("lists ignored dirs when include_ignored=true", async () => {
    const r = await executeTool(
      "list_files",
      { dirPath: ".", pattern: null, include_ignored: true },
      repoPath,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain("build/bundle.js");
  });

  it("respects the project's .gitignore by default", async () => {
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "secretdir/\n");
    fs.mkdirSync(path.join(repoPath, "secretdir"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "secretdir", "g.ts"), "export const x = 1;\n");

    const def = await executeTool(
      "list_files",
      { dirPath: ".", pattern: null, include_ignored: null },
      repoPath,
    );
    expect(def.output).not.toMatch(/secretdir/);

    const esc = await executeTool(
      "list_files",
      { dirPath: ".", pattern: null, include_ignored: true },
      repoPath,
    );
    expect(esc.output).toContain("secretdir/g.ts");
  });
});
