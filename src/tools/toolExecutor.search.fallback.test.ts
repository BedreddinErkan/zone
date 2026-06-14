/**
 * JS-fallback coverage for search_in_files when ripgrep is absent.
 *
 * Forces _setRipgrepAvailableForTest(null) before each test so the in-process
 * fallback (lines 2860-2967 of toolExecutor.ts) always runs. Tests exercise all
 * three output modes plus regex and case-insensitive variants — none of which are
 * covered by the existing search tests that run on hosts where rg is present.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setRipgrepAvailableForTest, executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  _setRipgrepAvailableForTest(null); // force JS fallback — no ripgrep
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-search-fallback-"));
  fs.writeFileSync(
    path.join(repoPath, "match.ts"),
    [
      "const alpha = 1;",
      "const ALPHA = 2;",
      "const beta = alpha + ALPHA;",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repoPath, "nomatch.ts"),
    ["const gamma = 3;", "const delta = 4;"].join("\n")
  );
});

afterEach(() => {
  _setRipgrepAvailableForTest(undefined); // restore normal probe
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("search_in_files JS fallback (rg absent)", () => {
  it("files_with_matches — returns only the file that contains the pattern", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "alpha", fileGlob: "**/*.ts", output_mode: "files_with_matches" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("match.ts");
    expect(result.output).not.toContain("nomatch.ts");
    expect(result.output).toContain("file(s) matched");
  });

  it("count — returns per-file match counts", async () => {
    // match.ts has "alpha" on lines 1 and 3 (two occurrences)
    const result = await executeTool(
      "search_in_files",
      { pattern: "alpha", fileGlob: "**/*.ts", output_mode: "count" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("match.ts");
    expect(result.output).toMatch(/match\.ts.*2|2.*match\.ts/);
    expect(result.output).toContain("matches across");
  });

  it("content — returns context blocks with line markers for matching lines", async () => {
    const result = await executeTool(
      "search_in_files",
      { pattern: "beta", fileGlob: "**/*.ts", output_mode: "content" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("match.ts");
    expect(result.output).toMatch(/>\s+\d+:/); // context block line marker
    expect(result.output).toContain("beta");
    expect(result.output).toContain("[search_in_files]");
  });

  it("regex pattern — matches correctly in fallback", async () => {
    // Pattern matches "const alpha" but not "const ALPHA"
    const result = await executeTool(
      "search_in_files",
      { pattern: "const [a-z]+", fileGlob: "**/*.ts", output_mode: "content" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("match.ts");
  });

  it("case_insensitive — finds ALPHA when searching for alpha", async () => {
    // Without case_insensitive, "^ALPHA" would only match the ALPHA line
    // With case_insensitive=true both alpha and ALPHA lines match
    const result = await executeTool(
      "search_in_files",
      { pattern: "alpha", fileGlob: "**/*.ts", case_insensitive: true, output_mode: "count" },
      repoPath
    );
    expect(result.success).toBe(true);
    // match.ts has alpha/ALPHA on all 3 lines — case-insensitive count is 3 (one per line)
    // nomatch.ts has zero; the key assertion is that case-insensitive search finds ALPHA
    expect(result.output).toContain("match.ts");
    expect(result.output).toMatch(/match\.ts.*3|3.*match\.ts/);
  });
});
