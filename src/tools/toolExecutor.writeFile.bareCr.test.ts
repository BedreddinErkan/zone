/**
 * Ledger item 42's write_file arm — write_file's own re-encode already prevents a spurious
 * whole-file diff for CRLF files ("Preserve CRLF for existing files", the comment directly
 * above); the same rationale applies unchanged to bare-CR files once analyzeLineEnding can
 * classify them. No match step here, unlike apply_patch/multi_edit — no coupling, which is why
 * this is its own commit rather than folded into the classifier + apply_patch + multi_edit fix.
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

async function writeFile(filePath: string, content: string, staging: Map<string, string>) {
  return executeTool(
    "write_file",
    { filePath, content },
    repoPath,
    undefined,
    { stagingFiles: staging }
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-write-file-bare-cr-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("write_file bare-CR line-ending re-encode (ledger item 42)", () => {
  it("overwriting an existing bare-CR file with LF content: staged content is re-encoded to CR", async () => {
    writeRepoBytes("doc.md", "line one\rline two\rline three\r");
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "doc.md");

    const result = await writeFile("doc.md", "line ONE\nline TWO\nline THREE\n", staging);

    expect(result.success).toBe(true);
    expect(staging.get(abs)).toBe("line ONE\rline TWO\rline THREE\r");
  });

  it("creating a new file (no prior content): written verbatim, unaffected by the cr branch", async () => {
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "new.md");

    const result = await writeFile("new.md", "alpha\rbeta\n", staging);

    expect(result.success).toBe(true);
    // New file writes directly to disk (fileExists === false skips the re-encode gate
    // entirely) rather than through the staging map — read back from disk.
    expect(staging.has(abs)).toBe(false);
    expect(fs.readFileSync(abs, "utf8")).toBe("alpha\rbeta\n");
  });

  it("overwriting a CRLF file (control): unchanged behavior, still CRLF", async () => {
    writeRepoBytes("doc.md", "line one\r\nline two\r\nline three\r\n");
    const staging = new Map<string, string>();
    const abs = path.resolve(repoPath, "doc.md");

    const result = await writeFile("doc.md", "line ONE\nline TWO\nline THREE\n", staging);

    expect(result.success).toBe(true);
    expect(staging.get(abs)).toBe("line ONE\r\nline TWO\r\nline THREE\r\n");
  });
});
