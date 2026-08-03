/**
 * Ledger items 41+42 — multi_edit carries the identical normalization asymmetry apply_patch had:
 * find/replace were already normalized for both CRLF and bare CR (:3318-3319), but the file's own
 * content was normalized for CRLF only, so a find spanning a bare CR could never match. Its
 * apparent CR "preservation" on the non-spanning path was accidental — nothing ever touched a
 * bare CR outside the matched region, not deliberate design — which is exactly why the match fix
 * had to land with a "cr" re-encode arm in the same commit: fixing content normalization alone
 * would have turned that accidental silence into active CR destruction on a path that works
 * today. Test 5 pins that regression guard; test 6 pins the fix itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

function writeRepoBytes(relPath: string, content: string): void {
  const abs = path.join(repoPath, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(content, "utf8"));
}

async function multiEdit(files: string[], find: string, replace: string, staging: Map<string, string>) {
  return executeTool(
    "multi_edit",
    { files, find, replace, wholeWord: null },
    repoPath,
    undefined,
    { stagingFiles: staging }
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-multi-edit-bare-cr-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("multi_edit bare-CR line-ending match and re-encode (ledger items 41+42)", () => {
  it("Case 1 — regression guard: find does NOT span a CR, CR is still preserved", async () => {
    const barecr = "line one\rline two\rline three\r";
    writeRepoBytes("doc.md", barecr);
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "doc.md");

    const result = await multiEdit(["doc.md"], "line two", "LINE TWO", staging);

    expect(result.success).toBe(true);
    expect(result.output).toContain("1 replacement(s)");
    expect(staging.get(abs)).toBe("line one\rLINE TWO\rline three\r");
  });

  it("Case 2 — the fix: find SPANS a bare CR (fails today), now matches and preserves CR", async () => {
    const barecr = "line one\rline two\rline three\r";
    writeRepoBytes("doc.md", barecr);
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "doc.md");

    const result = await multiEdit(["doc.md"], "line one\rline two", "NEW A\nNEW B", staging);

    expect(result.success).toBe(true);
    expect(result.output).toContain("1 replacement(s)");
    expect(staging.get(abs)).toBe("NEW A\rNEW B\rline three\r");
  });

  it("Case 3 — CRLF control: unchanged behavior", async () => {
    const crlf = "line one\r\nline two\r\nline three\r\n";
    writeRepoBytes("doc.md", crlf);
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "doc.md");

    const result = await multiEdit(["doc.md"], "line two", "LINE TWO", staging);

    expect(result.success).toBe(true);
    expect(staging.get(abs)).toBe("line one\r\nLINE TWO\r\nline three\r\n");
  });

  it("Case 4 — LF control: unchanged behavior", async () => {
    const lf = "line one\nline two\nline three\n";
    writeRepoBytes("doc.md", lf);
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "doc.md");

    const result = await multiEdit(["doc.md"], "line two", "LINE TWO", staging);

    expect(result.success).toBe(true);
    expect(staging.get(abs)).toBe("line one\nLINE TWO\nline three\n");
  });

  it("Case 5 (C1 correction) — find spans a CR AND replace itself contains a bare CR: output is uniformly CR, not mixed", async () => {
    const barecr = "line one\rline two\rline three\r";
    writeRepoBytes("doc.md", barecr);
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "doc.md");

    // replace itself carries a bare \r — pins that :3319's pre-existing normalization of
    // `replace` and :3348's new normalization of `content` agree once both are in play.
    const result = await multiEdit(["doc.md"], "line one\rline two", "NEW A\rNEW B", staging);

    expect(result.success).toBe(true);
    const staged = staging.get(abs);
    expect(staged).toBe("NEW A\rNEW B\rline three\r");
    expect(staged).not.toMatch(/(?<!\r)\n/); // zero bare LF
    expect(staged).not.toContain("\r\n"); // zero CRLF
  });
});
