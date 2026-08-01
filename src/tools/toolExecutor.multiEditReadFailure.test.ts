/**
 * multi_edit's per-file read failure: every read failure now records a
 * [zone-multi-edit-read-error] marker (ENOENT included — every path here was
 * asserted by the model as an edit target, so a missing file is a fault, not
 * the tool's benign case the way write_file's new-file path is). Rendering
 * stays split: ENOENT keeps [NOT FOUND]; anything else renders the real code
 * under a distinct label instead of asserting non-existence for a code that
 * was never inspected (toolExecutor.ts's per-file catch used to swallow it).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-me-read-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function abs(rel: string): string {
  return path.join(repoPath, rel);
}

/**
 * Throws EACCES for `target` on its first read only; every later call (any
 * path, including a second read of `target`) falls through to the real
 * readFileSync. No test in this file re-reads `target` after the tool call,
 * so there is nothing to restore — afterEach's vi.restoreAllMocks() is the
 * only cleanup this needs.
 */
function mockEaccesOnce(target: string): void {
  const realReadFileSync = fs.readFileSync;
  let attempted = false;
  vi.spyOn(fs, "readFileSync").mockImplementation((p: fs.PathOrFileDescriptor, opts?: BufferEncoding | { encoding: BufferEncoding }) => {
    if (p === target && !attempted) {
      attempted = true;
      const e = new Error(`EACCES: permission denied, open '${target}'`) as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    }
    return realReadFileSync(p, opts as BufferEncoding);
  });
}

describe("multi_edit — per-file read failure", () => {
  it("A — non-ENOENT read failure renders the real code in the tool output", async () => {
    const filePath = "src/existing.ts";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(filePath), "const foo = 1;\n", "utf8");

    mockEaccesOnce(abs(filePath));

    const result = await executeTool(
      "multi_edit",
      { files: [filePath], find: "foo", replace: "bar" },
      repoPath
    );

    expect(result.output).toContain("[READ ERROR: EACCES]");
  });

  it("B — non-ENOENT read failure does not render [NOT FOUND], and a sibling file's line is unaffected", async () => {
    const readable = "src/readable.ts";
    const failing = "src/failing.ts";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(readable), "const foo = 1;\n", "utf8");
    fs.writeFileSync(abs(failing), "const foo = 2;\n", "utf8");

    mockEaccesOnce(abs(failing));

    const result = await executeTool(
      "multi_edit",
      { files: [readable, failing], find: "foo", replace: "bar" },
      repoPath
    );

    expect(result.output).not.toContain("[NOT FOUND]");
    expect(result.output).toContain(`[READ ERROR: EACCES] ${failing}`);
    expect(result.output).toContain(`${readable}: 1 replacement(s)`);
  });

  it("C — emits [zone-multi-edit-read-error] naming the file that actually failed", async () => {
    const readable = "src/readable.ts";
    const failing = "src/failing.ts";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(readable), "const foo = 1;\n", "utf8");
    fs.writeFileSync(abs(failing), "const foo = 2;\n", "utf8");

    mockEaccesOnce(abs(failing));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await executeTool(
      "multi_edit",
      { files: [readable, failing], find: "foo", replace: "bar" },
      repoPath
    );

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-multi-edit-read-error]");
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.code).toBe("EACCES");
    expect(payload.filePath).toBe(failing);
  });

  it("D — ENOENT still renders [NOT FOUND] (unchanged)", async () => {
    const result = await executeTool(
      "multi_edit",
      { files: ["src/missing.ts"], find: "foo", replace: "bar" },
      repoPath
    );
    expect(result.output).toContain("[NOT FOUND] src/missing.ts");
  });

  it("E — readable file with zero matches renders exactly as today", async () => {
    const filePath = "src/noop.ts";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(filePath), "const unrelated = 1;\n", "utf8");

    const result = await executeTool(
      "multi_edit",
      { files: [filePath], find: "notPresent", replace: "x" },
      repoPath
    );
    expect(result.output).toContain(`${filePath}: 0 replacement(s)`);
  });

  it("F — ENOENT still emits [zone-multi-edit-read-error] (fault, not benign, for multi_edit)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await executeTool(
      "multi_edit",
      { files: ["src/missing.ts"], find: "foo", replace: "bar" },
      repoPath
    );

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-multi-edit-read-error]");
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.code).toBe("ENOENT");
  });

  it("G — codeless throw renders [READ ERROR: unknown], not [NOT FOUND] (@unverified-probe reachability)", async () => {
    const filePath = "src/existing.ts";
    fs.mkdirSync(abs("src"), { recursive: true });
    fs.writeFileSync(abs(filePath), "const foo = 1;\n", "utf8");

    const target = abs(filePath);
    const realReadFileSync = fs.readFileSync;
    let attempted = false;
    vi.spyOn(fs, "readFileSync").mockImplementation((p: fs.PathOrFileDescriptor, opts?: BufferEncoding | { encoding: BufferEncoding }) => {
      if (p === target && !attempted) {
        attempted = true;
        throw new Error("simulated failure with no .code property");
      }
      return realReadFileSync(p, opts as BufferEncoding);
    });

    const result = await executeTool(
      "multi_edit",
      { files: [filePath], find: "foo", replace: "bar" },
      repoPath
    );

    expect(result.output).toContain("[READ ERROR: unknown]");
    expect(result.output).not.toContain("[NOT FOUND]");
  });
});
