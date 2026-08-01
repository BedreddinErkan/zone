/**
 * search_in_files's in-process fallback (used when rg is unavailable): both
 * per-file read catches used to drop a file silently on ANY failure — no
 * sentinel at all, unlike multi_edit's count:-1. An unreadable file and a
 * file with zero matches were computationally identical from the return
 * statement onward. This pass adds no output-visible signal (see the plan:
 * search_in_files's file list is auto-discovered, not model-named, so a
 * per-file "could not read" message is far less actionable than multi_edit's
 * — the marker is the only discriminating signal this fix produces).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setRipgrepAvailableForTest, executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  _setRipgrepAvailableForTest(null); // force JS fallback — no ripgrep
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-search-read-"));
});

afterEach(() => {
  _setRipgrepAvailableForTest(undefined); // restore normal probe
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function abs(rel: string): string {
  return path.join(repoPath, rel);
}

/**
 * Throws a `code`-coded error for `target` on its first read only; every
 * later call (any path, including a second read of `target`) falls through
 * to the real readFileSync. Generalized over the error code (unlike prior
 * passes' EACCES-only helper) because this file needs both EACCES and
 * ENOENT injection.
 */
function mockReadFailureOnce(target: string, code: string): void {
  const realReadFileSync = fs.readFileSync;
  let attempted = false;
  vi.spyOn(fs, "readFileSync").mockImplementation((p: fs.PathOrFileDescriptor, opts?: BufferEncoding | { encoding: BufferEncoding }) => {
    if (p === target && !attempted) {
      attempted = true;
      const e = new Error(`${code}: simulated failure, open '${target}'`) as NodeJS.ErrnoException;
      e.code = code;
      throw e;
    }
    return realReadFileSync(p, opts as BufferEncoding);
  });
}

describe("search_in_files — in-process fallback read failure", () => {
  it("A — files_with_matches: emits the marker with code, filePath, and outputMode", async () => {
    fs.writeFileSync(abs("alpha.ts"), "const foo = 1;\n", "utf8");
    fs.writeFileSync(abs("zulu.ts"), "const foo = 2;\n", "utf8");
    mockReadFailureOnce(abs("zulu.ts"), "EACCES");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts", output_mode: "files_with_matches" },
      repoPath
    );

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-search-in-files-read-error]");
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.code).toBe("EACCES");
    expect(payload.filePath).toBe("zulu.ts");
    expect(payload.outputMode).toBe("files_with_matches");
  });

  it("B — files_with_matches: a sibling file's match survives a neighbor's read failure", async () => {
    fs.writeFileSync(abs("alpha.ts"), "const foo = 1;\n", "utf8");
    fs.writeFileSync(abs("zulu.ts"), "const foo = 2;\n", "utf8");
    mockReadFailureOnce(abs("zulu.ts"), "EACCES");

    const result = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts", output_mode: "files_with_matches" },
      repoPath
    );

    expect(result.output).toContain("alpha.ts");
  });

  it("C — content: emits the marker with code, filePath, and outputMode", async () => {
    fs.writeFileSync(abs("alpha.ts"), "const foo = 1;\n", "utf8");
    fs.writeFileSync(abs("zulu.ts"), "const foo = 2;\n", "utf8");
    mockReadFailureOnce(abs("zulu.ts"), "EACCES");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts", output_mode: "content" },
      repoPath
    );

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-search-in-files-read-error]");
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.code).toBe("EACCES");
    expect(payload.filePath).toBe("zulu.ts");
    expect(payload.outputMode).toBe("content");
  });

  it("D — content: a sibling file's match survives a neighbor's read failure", async () => {
    fs.writeFileSync(abs("alpha.ts"), "const foo = 1;\n", "utf8");
    fs.writeFileSync(abs("zulu.ts"), "const foo = 2;\n", "utf8");
    mockReadFailureOnce(abs("zulu.ts"), "EACCES");

    const result = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts", output_mode: "content" },
      repoPath
    );

    expect(result.output).toContain("alpha.ts");
  });

  it("E — a successfully-read file with zero matches does not emit the marker", async () => {
    fs.writeFileSync(abs("quiet.ts"), "const unrelated = 1;\n", "utf8");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts", output_mode: "files_with_matches" },
      repoPath
    );

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-search-in-files-read-error]");
    expect(call).toBeUndefined();
    expect(result.output).toContain("(no matches)");
  });

  it("F — ENOENT (file vanished between glob and read) still fires the marker", async () => {
    fs.writeFileSync(abs("alpha.ts"), "const foo = 1;\n", "utf8");
    fs.writeFileSync(abs("zulu.ts"), "const foo = 2;\n", "utf8");
    mockReadFailureOnce(abs("zulu.ts"), "ENOENT");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await executeTool(
      "search_in_files",
      { pattern: "foo", fileGlob: "**/*.ts", output_mode: "files_with_matches" },
      repoPath
    );

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-search-in-files-read-error]");
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.code).toBe("ENOENT");
    expect(result.output).toContain("alpha.ts");
  });
});
