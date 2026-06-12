import { vi, describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs");

import { computeFileDiff, diffToFindReplace, buildStagedDiffs, buildRestageSeedBlock } from "./fileDiff.js";

const mockFs = fs as unknown as { readFileSync: ReturnType<typeof vi.fn> };

describe("computeFileDiff", () => {
  it("empty before = all added", () => {
    const diff = computeFileDiff("", "hello");
    expect(diff).toEqual([{ type: "added", content: "hello", lineNumber: 1 }]);
  });

  it("empty after = all removed", () => {
    const diff = computeFileDiff("hello", "");
    expect(diff).toEqual([{ type: "removed", content: "hello", lineNumber: 1 }]);
  });

  it("identical content = all unchanged", () => {
    const diff = computeFileDiff("a\nb", "a\nb");
    expect(diff.every((l) => l.type === "unchanged")).toBe(true);
  });

  it("one line changed", () => {
    const diff = computeFileDiff("a\nb\nc", "a\nx\nc");
    const changed = diff.filter((l) => l.type !== "unchanged");
    expect(changed.some((l) => l.type === "removed" && l.content === "b")).toBe(true);
    expect(changed.some((l) => l.type === "added" && l.content === "x")).toBe(true);
  });
});

describe("diffToFindReplace", () => {
  it("empty diff returns empty string", () => {
    expect(diffToFindReplace([])).toBe("");
  });

  it("all unchanged returns empty string", () => {
    const diff = computeFileDiff("a\nb", "a\nb");
    expect(diffToFindReplace(diff)).toBe("");
  });

  it("simple add-only (new file) produces one FIND/REPLACE block", () => {
    const diff = computeFileDiff("", "hello\nworld");
    const out = diffToFindReplace(diff);
    expect(out).toContain("--- FIND ---");
    expect(out).toContain("--- REPLACE ---");
    expect(out).toContain("hello");
  });

  it("delete-only produces one FIND/REPLACE block", () => {
    const diff = computeFileDiff("gone", "");
    const out = diffToFindReplace(diff);
    expect(out).toContain("--- FIND ---");
    expect(out).toContain("gone");
    expect(out).toContain("--- REPLACE ---");
  });

  it("multi-hunk: two separate change regions produce two FIND/REPLACE blocks", () => {
    const diff = computeFileDiff("a\nb\nc\nd", "a\nX\nc\nY");
    const out = diffToFindReplace(diff);
    const findCount = (out.match(/--- FIND ---/g) ?? []).length;
    expect(findCount).toBe(2);
  });
});

describe("buildStagedDiffs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("new file (ENOENT) → before='', added=lines, removed=0", () => {
    mockFs.readFileSync.mockImplementation(() => {
      const e = new Error("ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    });
    const staging = new Map([["/repo/new.ts", "line1\nline2"]]);
    const result = buildStagedDiffs(staging, "/repo");
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("new.ts");
    expect(result[0]!.removed).toBe(0);
    expect(result[0]!.added).toBe(2);
  });

  it("modified file: computes correct added/removed counts", () => {
    mockFs.readFileSync.mockReturnValue("old\nstable\nold2");
    const staging = new Map([["/repo/f.ts", "new\nstable\nnew2"]]);
    const result = buildStagedDiffs(staging, "/repo");
    expect(result[0]!.added).toBe(2);
    expect(result[0]!.removed).toBe(2);
    expect(result[0]!.path).toBe("f.ts");
  });

  it("path is relative to repoPath", () => {
    mockFs.readFileSync.mockReturnValue("old");
    const staging = new Map([["/repo/src/a.ts", "new"]]);
    const result = buildStagedDiffs(staging, "/repo");
    expect(result[0]!.path).toBe("src/a.ts");
  });

  it("propagates non-ENOENT errors", () => {
    mockFs.readFileSync.mockImplementation(() => {
      const e = new Error("EPERM") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });
    const staging = new Map([["/repo/f.ts", "content"]]);
    expect(() => buildStagedDiffs(staging, "/repo")).toThrow("EPERM");
  });
});

describe("buildRestageSeedBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("empty staging returns empty string", () => {
    expect(buildRestageSeedBlock(new Map(), "/repo")).toBe("");
  });

  it("non-empty staging returns block with PRIOR STAGING ATTEMPT markers", () => {
    mockFs.readFileSync.mockReturnValue("old");
    const staging = new Map([["/repo/f.ts", "new"]]);
    const block = buildRestageSeedBlock(staging, "/repo");
    expect(block).toContain("PRIOR STAGING ATTEMPT");
    expect(block).toContain("END PRIOR STAGING ATTEMPT");
    expect(block).toContain("f.ts");
  });
});
