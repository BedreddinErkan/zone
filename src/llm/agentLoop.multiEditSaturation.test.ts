/**
 * agentLoop.ts:2372's documented defect: multi_edit's terminal return sets
 * success:true even with 0 replacements, so the chain-saturation filter's old
 * `e.success === true` check couldn't tell a no-op multi_edit from a real
 * one. countsTowardChainSaturation() reads ToolCallLogEntry.filesStaged
 * instead — this file exercises the real multi_edit path via executeTool,
 * then feeds the real result.filesStaged into the new predicate directly,
 * so a change to how toolExecutor.ts populates the field would be caught
 * here too, not just a hand-typed literal matching today's shape.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "../tools/toolExecutor.js";
import { countsTowardChainSaturation, multiEditChangedSomething } from "./agentLoop.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-me-saturation-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function abs(rel: string): string {
  return path.join(repoPath, rel);
}

/**
 * Throws a `code`-coded error for `target` on its first read only; every
 * later call (any path, including a second read of `target`) falls through
 * to the real readFileSync.
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

describe("multi_edit chain-saturation counting", () => {
  it("A — a zero-match multi_edit does not count toward chain saturation", async () => {
    const filePath = "noop.ts";
    fs.writeFileSync(abs(filePath), "const unrelated = 1;\n", "utf8");
    const result = await executeTool("multi_edit", { files: [filePath], find: "foo", replace: "bar" }, repoPath);
    expect(countsTowardChainSaturation(
      { id: "1", tool: "multi_edit", args: {}, result: "", success: result.success, filesStaged: result.filesStaged },
      true
    )).toBe(false);
  });

  it("B — an all-unreadable multi_edit does not count toward chain saturation", async () => {
    const filePath = "unreadable.ts";
    fs.writeFileSync(abs(filePath), "const foo = 1;\n", "utf8");
    mockReadFailureOnce(abs(filePath), "EACCES");
    const result = await executeTool("multi_edit", { files: [filePath], find: "foo", replace: "bar" }, repoPath);
    expect(countsTowardChainSaturation(
      { id: "1", tool: "multi_edit", args: {}, result: "", success: result.success, filesStaged: result.filesStaged },
      true
    )).toBe(false);
  });

  it("C — a real edit still counts toward chain saturation", async () => {
    const filePath = "edited.ts";
    fs.writeFileSync(abs(filePath), "const foo = 1;\n", "utf8");
    const result = await executeTool("multi_edit", { files: [filePath], find: "foo", replace: "bar" }, repoPath);
    expect(countsTowardChainSaturation(
      { id: "1", tool: "multi_edit", args: {}, result: "", success: result.success, filesStaged: result.filesStaged },
      true
    )).toBe(true);
  });

  it("D — a partially-successful multi_edit (one edited, one unreadable) still counts", async () => {
    const editedFile = "edited.ts";
    const unreadableFile = "unreadable.ts";
    fs.writeFileSync(abs(editedFile), "const foo = 1;\n", "utf8");
    fs.writeFileSync(abs(unreadableFile), "const foo = 2;\n", "utf8");
    mockReadFailureOnce(abs(unreadableFile), "EACCES");
    const result = await executeTool(
      "multi_edit",
      { files: [editedFile, unreadableFile], find: "foo", replace: "bar" },
      repoPath
    );
    expect(countsTowardChainSaturation(
      { id: "1", tool: "multi_edit", args: {}, result: "", success: result.success, filesStaged: result.filesStaged },
      true
    )).toBe(true);
  });

  it("E — item 47: a pre-flight-rejected batch carries no staged paths at all, not even the ones before the escape", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-me-outside-"));
    const insideFile = "inside.ts";
    fs.writeFileSync(abs(insideFile), "const foo = 1;\n", "utf8");
    const outsideAbs = path.join(outsideDir, "escape.ts");
    fs.writeFileSync(outsideAbs, "const foo = 2;\n", "utf8");
    const escapeRelPath = path.relative(repoPath, outsideAbs);

    const result = await executeTool(
      "multi_edit",
      { files: [insideFile, escapeRelPath], find: "foo", replace: "bar" },
      repoPath,
      undefined,
      { stagingFiles: new Map() }
    );

    expect(result.filesStaged).toEqual([]);
    expect(result.success).toBe(false);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("F — apply_patch entries still count, and the multi_edit helper never fires for them", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const entry = { id: "1", tool: "apply_patch", args: {}, result: "", success: true };
    expect(countsTowardChainSaturation(entry, true)).toBe(true);
    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-multi-edit-log-missing-staged]");
    expect(call).toBeUndefined();
  });

  it("G — a multi_edit entry missing filesStaged fires the marker and does not count", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const entry = { id: "abc123", tool: "multi_edit", args: {}, result: "", success: true };
    expect(multiEditChangedSomething(entry)).toBe(false);
    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-multi-edit-log-missing-staged]");
    expect(call).toBeDefined();
  });

  it("I — a no-op multi_edit entry does not break a chain-saturation streak", () => {
    const log = [
      { id: "1", tool: "multi_edit", args: {}, result: "", success: true, filesStaged: [] },
    ];
    expect(log.filter((e) => countsTowardChainSaturation(e, true)).length === 0).toBe(true);
  });
});
