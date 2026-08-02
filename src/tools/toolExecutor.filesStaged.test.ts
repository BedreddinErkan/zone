/**
 * Item 14: apply_patch/write_file gain filesStaged the way multi_edit already has it —
 * repo-relative paths of files this call left with a PERSISTING content change, not
 * merely an attempted one. Exercises toolExecutor.ts's apply_patch/write_file handlers
 * directly, mirroring toolExecutor.multiEdit.test.ts's own "filesStaged (Part A)" section.
 *
 * .js fixtures are used for the rollback-path tests deliberately: findCheckerForFile has
 * no entry for .js, so the inline-tsc-check block's `if (!checker)` branch fires
 * synchronously — zero subprocess spawn, regardless of whether tsc/npx are resolvable on
 * the test machine. The POST-write validateSyntax check these tests actually want to
 * exercise is a pure in-process @babel/parser call either way.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-files-staged-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function abs(rel: string): string {
  return path.join(repoPath, rel);
}
function writeRepoFile(filePath: string, content: string): void {
  const target = abs(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}
function readRepoFile(filePath: string): string {
  return fs.readFileSync(abs(filePath), "utf8");
}

/**
 * Throws EACCES for fs.unlinkSync(target) on its first call only; every later call (any
 * path) falls through to the real unlinkSync. Mirrors
 * toolExecutor.writeFileReadFailure.test.ts's mockEaccesOnce — proven deterministic and
 * portable in this suite already, unlike chmod-style permission tricks, which don't
 * reliably block root-run CI containers.
 */
function mockUnlinkEaccesOnce(target: string): { restore: () => void } {
  const realUnlinkSync = fs.unlinkSync;
  let attempted = false;
  const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((p: fs.PathLike) => {
    if (p === target && !attempted) {
      attempted = true;
      const e = new Error(`EACCES: permission denied, unlink '${target}'`) as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    }
    return realUnlinkSync(p);
  });
  return { restore: () => spy.mockRestore() };
}

/**
 * Throws EACCES for fs.existsSync(target) on its first call only — simulates the
 * survival-check itself being inconclusive (C1: existsSync is documented as not
 * throwing for a missing path, but can still throw on EACCES/ENOTDIR/ELOOP against the
 * parent directory), independent of whether the preceding unlinkSync succeeded.
 */
function mockExistsSyncThrowsOnce(target: string): { restore: () => void } {
  const realExistsSync = fs.existsSync;
  let attempted = false;
  const spy = vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
    if (p === target && !attempted) {
      attempted = true;
      const e = new Error(`EACCES: permission denied, stat '${target}'`) as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    }
    return realExistsSync(p);
  });
  return { restore: () => spy.mockRestore() };
}

describe("apply_patch filesStaged", () => {
  it("full success (return #27) sets filesStaged to [filePath]", async () => {
    writeRepoFile("src/target.ts", "const x = 1;\n");
    const result = await executeTool(
      "apply_patch",
      { filePath: "src/target.ts", patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;", intent: "modify", scope: null },
      repoPath, undefined, {}
    );
    expect(result.success).toBe(true);
    expect(result.filesStaged).toEqual(["src/target.ts"]);
  });

  it("post-write syntax-broken rollback (return #24) omits filesStaged — content restored, not persisted", async () => {
    const original = "const x = 1;\n";
    writeRepoFile("src/target.js", original);
    const result = await executeTool(
      "apply_patch",
      { filePath: "src/target.js", patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 1;\nfunction broken(", intent: "modify", scope: null },
      repoPath, undefined, {}
    );
    expect(result.success).toBe(false);
    expect(result.rejectionReason).toBe("syntax_broken_post_write");
    expect(readRepoFile("src/target.js")).toBe(original);
    expect(result.filesStaged).toBeUndefined();
  });
});

describe("write_file filesStaged", () => {
  it("success on an existing file (return #10, staged-edit branch) sets filesStaged to [filePath]", async () => {
    writeRepoFile("src/existing.ts", "const x = 1;\n");
    const result = await executeTool(
      "write_file", { filePath: "src/existing.ts", content: "const x = 2;\n" }, repoPath, undefined, { stagingFiles: new Map() }
    );
    expect(result.success).toBe(true);
    expect(result.filesStaged).toEqual(["src/existing.ts"]);
  });

  it("success on a new file (return #10, direct-to-disk branch) sets filesStaged to [filePath]", async () => {
    const result = await executeTool("write_file", { filePath: "src/new.ts", content: "export const x = 1;\n" }, repoPath);
    expect(result.success).toBe(true);
    expect(result.filesStaged).toEqual(["src/new.ts"]);
  });

  it("existing-file syntax-broken rollback omits filesStaged — content restored, not persisted", async () => {
    const original = "export const ok = 1;\n";
    writeRepoFile("src/existing2.ts", original);
    const result = await executeTool(
      "write_file", { filePath: "src/existing2.ts", content: "export const broken = {\n  // unclosed brace" },
      repoPath, undefined, { stagingFiles: new Map() }
    );
    expect(result.success).toBe(false);
    expect(readRepoFile("src/existing2.ts")).toBe(original);
    expect(result.filesStaged).toBeUndefined();
  });

  it("new-file syntax-broken rollback with successful unlink omits filesStaged", async () => {
    const filePath = "src/broken.ts";
    const result = await executeTool("write_file", { filePath, content: "export const broken = {\n  // unclosed brace" }, repoPath);
    expect(result.success).toBe(false);
    expect(fs.existsSync(abs(filePath))).toBe(false);
    expect(result.filesStaged).toBeUndefined();
  });

  it("new-file syntax-broken rollback whose unlink fails reports the survivor in filesStaged", async () => {
    const filePath = "src/broken2.ts";
    const target = abs(filePath);
    const { restore } = mockUnlinkEaccesOnce(target);
    const result = await executeTool("write_file", { filePath, content: "export const broken = {\n  // unclosed brace" }, repoPath);
    restore();
    expect(result.success).toBe(false);
    expect(result.rejectionReason).toBe("syntax_broken_post_write");
    expect(fs.existsSync(target)).toBe(true);
    expect(result.filesStaged).toEqual([filePath]);
  });

  // C1: the survival CHECK itself (fs.existsSync) can throw, independent of whether the
  // unlink that preceded it succeeded. The marker assertion is asserted FIRST — a
  // mutation that deletes the log() call but leaves the false-default intact must fail
  // this test at that first assertion, not silently pass by never reaching it.
  it("new-file rollback whose survival check (existsSync) throws logs the marker and defaults filesStaged to absent", async () => {
    const filePath = "src/broken3.ts";
    const target = abs(filePath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { restore } = mockExistsSyncThrowsOnce(target);

    const result = await executeTool("write_file", { filePath, content: "export const broken = {\n  // unclosed brace" }, repoPath);
    restore();

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-write-file-unlink-check-failed]");
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;
    expect(payload.code).toBe("EACCES");
    // The chosen default (false/absent), not a guess about the file's real state — the
    // check itself was inconclusive.
    expect(result.filesStaged).toBeUndefined();
    logSpy.mockRestore();
  });
});

describe("filesStaged normalization matches across apply_patch/write_file/multi_edit", () => {
  it("an absolute filePath inside the repo normalizes to the same repo-relative form for all three tools", async () => {
    const rel = "src/shared.ts";

    writeRepoFile(rel, "const a = 1;\n");
    const apResult = await executeTool(
      "apply_patch",
      { filePath: abs(rel), patch: "--- FIND ---\nconst a = 1;\n--- REPLACE ---\nconst a = 2;", intent: "modify", scope: null },
      repoPath, undefined, {}
    );
    expect(apResult.filesStaged).toEqual([rel]);

    writeRepoFile(rel, "const a = 1;\n");
    const wfResult = await executeTool(
      "write_file", { filePath: abs(rel), content: "const a = 3;\n" }, repoPath, undefined, { stagingFiles: new Map() }
    );
    expect(wfResult.filesStaged).toEqual([rel]);

    writeRepoFile(rel, "const a = 1;\n");
    const meResult = await executeTool(
      "multi_edit", { files: [abs(rel)], find: "const a", replace: "const b" }, repoPath, undefined, {}
    );
    expect(meResult.filesStaged).toEqual([rel]);
  });
});
