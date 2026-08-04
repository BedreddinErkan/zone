/**
 * Item 28 — write_file/apply_patch post-write rollback messages must derive from what the
 * restore actually did, not assert "The file has been reverted." unconditionally. Covers the
 * three RestoreOutcome states (toolExecutor.ts) at one representative site per tool per state;
 * filesStaged.test.ts already covers the filesStaged/rejectionReason/disk-content shape on
 * these same scenarios and is left untouched — this file adds the message-text + new-field
 * coverage that never existed before.
 *
 * .js fixtures for the same reason filesStaged.test.ts uses them: no checker entry for .js, so
 * post-write validation is a pure in-process @babel/parser call, no subprocess.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-rollback-msg-"));
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

/** Throws EACCES for fs.unlinkSync(target) on its first call only; later calls fall through. */
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
 * Throws EACCES for fs.writeFileSync(target, ...) on its SECOND call only for that path — the
 * first call is the forward write that lands the broken content (must succeed so validation has
 * something to reject), the second is the rollback attempt (the one this test wants to fail).
 * First-call-only would hit the forward write instead and never exercise the rollback at all.
 */
function mockWriteFileSyncEaccesOnSecondCall(target: string): { restore: () => void } {
  const realWriteFileSync = fs.writeFileSync;
  let callCount = 0;
  const spy = vi
    .spyOn(fs, "writeFileSync")
    .mockImplementation((p: fs.PathOrFileDescriptor, data: unknown, opts?: unknown) => {
      if (p === target) {
        callCount++;
        if (callCount === 2) {
          const e = new Error(`EACCES: permission denied, open '${target}'`) as NodeJS.ErrnoException;
          e.code = "EACCES";
          throw e;
        }
      }
      return realWriteFileSync(p, data as never, opts as never);
    });
  return { restore: () => spy.mockRestore() };
}

describe("write_file rollback message (item 28)", () => {
  it("clean existing-file rollback still says the file has been reverted", async () => {
    const original = "export const ok = 1;\n";
    writeRepoFile("src/clean.ts", original);
    const result = await executeTool(
      "write_file",
      { filePath: "src/clean.ts", content: "export const broken = {\n  // unclosed brace" },
      repoPath
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("The file has been reverted.");
    expect(result.filesStaged).toBeUndefined();
    expect(readRepoFile("src/clean.ts")).toBe(original);
  });

  it("new-file rollback whose unlink fails reports the survivor and says it could not be removed", async () => {
    const filePath = "src/newbroken.ts";
    const target = abs(filePath);
    const { restore } = mockUnlinkEaccesOnce(target);
    const result = await executeTool(
      "write_file",
      { filePath, content: "export const broken = {\n  // unclosed brace" },
      repoPath
    );
    restore();
    expect(result.filesStaged).toEqual([filePath]);
    expect(result.success).toBe(false);
    expect(result.output).toContain("could not be fully removed");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("existing-file rollback whose restore-write fails reports it and says it could not be restored", async () => {
    const filePath = "src/existingbroken.ts";
    const target = abs(filePath);
    const original = "export const ok = 1;\n";
    writeRepoFile(filePath, original);
    const brokenContent = "export const broken = {\n  // unclosed brace";
    const { restore } = mockWriteFileSyncEaccesOnSecondCall(target);
    const result = await executeTool("write_file", { filePath, content: brokenContent }, repoPath);
    restore();
    expect(result.filesStaged).toEqual([filePath]);
    expect(result.success).toBe(false);
    expect(result.output).toContain("could not be restored to its original content");
    expect(readRepoFile(filePath)).toBe(brokenContent);
  });
});

describe("apply_patch rollback message (item 28)", () => {
  it("clean rollback still says the file has been reverted", async () => {
    const original = "const x = 1;\n";
    writeRepoFile("src/target.js", original);
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/target.js",
        patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 1;\nfunction broken(",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("The file has been reverted.");
    expect(result.filesStaged).toBeUndefined();
  });

  it("restore-write fails reports it and says it could not be restored", async () => {
    const filePath = "src/target2.js";
    const target = abs(filePath);
    const original = "const x = 1;\n";
    writeRepoFile(filePath, original);
    const { restore } = mockWriteFileSyncEaccesOnSecondCall(target);
    const result = await executeTool(
      "apply_patch",
      {
        filePath,
        patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 1;\nfunction broken(",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );
    restore();
    expect(result.filesStaged).toEqual([filePath]);
    expect(result.success).toBe(false);
    expect(result.output).toContain("could not be restored to its original content");
    expect(readRepoFile(filePath)).not.toBe(original);
  });
});
