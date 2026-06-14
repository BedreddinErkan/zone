/**
 * write_file CRLF preservation tests.
 *
 * write_file must detect the existing file's dominant line ending and
 * re-encode the new content to match — preventing a spurious whole-file diff
 * when editing CRLF files. New files default to LF.
 *
 * Fail-before: before the fix, all three tests below would use the raw LF
 * content verbatim, so CRLF assertions would fail (the staged content would
 * be LF-only).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-wf-crlf-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function abs(rel: string): string {
  return path.join(repoPath, rel);
}

describe("write_file CRLF preservation", () => {
  it("CRLF file + LF input → staged content uses CRLF", async () => {
    fs.mkdirSync(abs("src"), { recursive: true });
    // Existing on-disk file uses CRLF
    fs.writeFileSync(abs("src/file.ts"), "line1\r\nline2\r\n", "utf8");

    const staging = new Map<string, string>();
    const result = await executeTool(
      "write_file",
      { filePath: "src/file.ts", content: "line1\nline2\n" }, // incoming LF
      repoPath,
      undefined,
      { stagingFiles: staging }
    );

    expect(result.success).toBe(true);
    const staged = staging.get(abs("src/file.ts"));
    expect(staged).toBeDefined();
    expect(staged).toContain("\r\n");          // re-encoded to CRLF
    expect(staged).not.toContain("\r\r\n");    // no doubled CRs
    expect(staged).toBe("line1\r\nline2\r\n"); // exact match
  });

  it("CRLF file + CRLF input → no doubled carriage returns (normalize-first guard)", async () => {
    fs.mkdirSync(abs("src"), { recursive: true });
    // Existing on-disk file uses CRLF
    fs.writeFileSync(abs("src/file.ts"), "line1\r\nline2\r\n", "utf8");

    const staging = new Map<string, string>();
    const result = await executeTool(
      "write_file",
      { filePath: "src/file.ts", content: "line1\r\nline2\r\n" }, // incoming already CRLF
      repoPath,
      undefined,
      { stagingFiles: staging }
    );

    expect(result.success).toBe(true);
    const staged = staging.get(abs("src/file.ts"));
    expect(staged).toBeDefined();
    expect(staged).not.toContain("\r\r\n");    // must not double CR
    expect(staged).toBe("line1\r\nline2\r\n"); // clean CRLF
  });

  it("new file (no prior content) → written as LF, no CRLF introduced", async () => {
    const result = await executeTool(
      "write_file",
      { filePath: "src/newfile.ts", content: "line1\nline2\n" },
      repoPath
    );

    expect(result.success).toBe(true);
    const written = fs.readFileSync(abs("src/newfile.ts"), "utf8");
    expect(written).toBe("line1\nline2\n");
    expect(written).not.toContain("\r");
  });
});
