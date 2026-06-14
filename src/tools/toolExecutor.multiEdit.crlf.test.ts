import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

function writeRepoBytes(relPath: string, content: string): void {
  const abs = path.join(repoPath, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Write raw bytes — content string is used verbatim (CRLF or LF bytes as authored).
  fs.writeFileSync(abs, Buffer.from(content, "utf8"));
}

async function multiEdit(
  files: string[],
  find: string,
  replace: string,
  staging: Map<string, string>,
  opts: { wholeWord?: boolean | null } = {},
) {
  return executeTool(
    "multi_edit",
    { files, find, replace, wholeWord: opts.wholeWord ?? null },
    repoPath,
    undefined,
    { stagingFiles: staging },
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-multi-edit-crlf-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("multi_edit CRLF handling", () => {
  it("Case 1 — CRLF file, multi-line find (the actual bug): match succeeds and CRLF is preserved", async () => {
    // File on disk uses CRLF line endings (Windows / core.autocrlf=true).
    const crlfContent = "line1\r\nold line\r\nline3\r\n";
    writeRepoBytes("crlf.ts", crlfContent);
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "crlf.ts");

    // LLM always emits LF in the find/replace strings.
    // Pre-fix: LF pattern "old line\nline3" cannot match CRLF content
    //   "old line\r\nline3" → count 0 → file unchanged.
    // Post-fix: both sides normalized to LF before matching, match succeeds,
    //   output re-encoded to CRLF before write.
    const result = await multiEdit(["crlf.ts"], "old line\nline3", "new line\nline3", staging);

    expect(result.success).toBe(true);
    expect(result.output).toContain("1 replacement(s)");

    // Critical: staged content MUST retain CRLF after the replacement.
    const staged = staging.get(abs);
    expect(staged).toBe("line1\r\nnew line\r\nline3\r\n");
    expect(staged).not.toContain("\r\r"); // no double-encode
  });

  it("Case 2 — LF file (happy-path guard): LF preserved after replacement", async () => {
    const lfContent = "line1\nold line\nline3\n";
    writeRepoBytes("lf.ts", lfContent);
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "lf.ts");

    const result = await multiEdit(["lf.ts"], "old line\nline3", "new line\nline3", staging);

    expect(result.success).toBe(true);
    expect(result.output).toContain("1 replacement(s)");

    const staged = staging.get(abs);
    expect(staged).toBe("line1\nnew line\nline3\n");
    expect(staged).not.toContain("\r"); // no CRLF introduced
  });

  it("Case 3 — no-match unaffected: CRLF file with absent find string stays unchanged", async () => {
    const crlfContent = "line1\r\nsome text\r\nline3\r\n";
    writeRepoBytes("crlf-no-match.ts", crlfContent);
    const staging = new Map<string, string>();

    const result = await multiEdit(
      ["crlf-no-match.ts"],
      "not present\nline3",
      "anything",
      staging,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("0 replacement(s)");
    // No staging entry written — file would be unchanged on flush.
    expect(staging.size).toBe(0);
  });
});
