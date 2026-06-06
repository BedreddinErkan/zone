import { describe, it, expect } from "vitest";
import {
  buildToolCallPatch,
  WRITE_FILE_PREVIEW_LINES,
  WRITE_FILE_PATCH_CAP,
} from "./toolCallPatch.js";

describe("buildToolCallPatch — apply_patch", () => {
  it("returns the patch string for apply_patch", () => {
    const patch = "--- FIND ---\nold\n--- REPLACE ---\nnew";
    expect(buildToolCallPatch("apply_patch", { patch }, "existing")).toBe(patch);
  });

  it("returns undefined when apply_patch has no patch arg", () => {
    expect(buildToolCallPatch("apply_patch", {}, "existing")).toBeUndefined();
  });

  it("returns undefined when apply_patch patch is not a string", () => {
    expect(buildToolCallPatch("apply_patch", { patch: 123 }, "existing")).toBeUndefined();
  });
});

describe("buildToolCallPatch — write_file new file", () => {
  it("returns an all-additions patch for a new file (empty beforeContent)", () => {
    const result = buildToolCallPatch("write_file", { content: "line1\nline2" }, "");
    expect(result).toBeDefined();
    expect(result).toContain("--- FIND ---");
    expect(result).toContain("--- REPLACE ---");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    // FIND section must be empty (new file = all additions)
    const findSection = result!.split("--- REPLACE ---")[0].replace("--- FIND ---", "").trim();
    expect(findSection).toBe("");
  });

  it("returns undefined for write_file on existing file (non-empty beforeContent)", () => {
    expect(buildToolCallPatch("write_file", { content: "new content" }, "old content")).toBeUndefined();
  });

  it("returns undefined when beforeContent is undefined (unknown state)", () => {
    expect(buildToolCallPatch("write_file", { content: "new" }, undefined)).toBeUndefined();
  });

  it("returns undefined when content arg is missing", () => {
    expect(buildToolCallPatch("write_file", {}, "")).toBeUndefined();
  });

  it(`caps content at WRITE_FILE_PATCH_CAP (${WRITE_FILE_PATCH_CAP}) lines`, () => {
    const lines = Array.from({ length: WRITE_FILE_PATCH_CAP + 10 }, (_, i) => `line${i}`);
    const result = buildToolCallPatch("write_file", { content: lines.join("\n") }, "");
    const replaceSection = result!.split("--- REPLACE ---")[1];
    const resultLines = replaceSection.trim().split("\n");
    expect(resultLines).toHaveLength(WRITE_FILE_PATCH_CAP);
  });

  it("includes all lines when file is shorter than cap", () => {
    const content = "a\nb\nc";
    const result = buildToolCallPatch("write_file", { content }, "");
    expect(result).toContain("a\nb\nc");
  });

  it("handles Windows line endings", () => {
    const result = buildToolCallPatch("write_file", { content: "line1\r\nline2" }, "");
    const replaceSection = result!.split("--- REPLACE ---")[1];
    expect(replaceSection).toContain("line1");
    expect(replaceSection).toContain("line2");
  });
});

describe("buildToolCallPatch — multi_edit", () => {
  it("returns a FIND/REPLACE patch for multi_edit", () => {
    const result = buildToolCallPatch("multi_edit", { find: "oldName", replace: "newName", files: ["a.ts", "b.ts"] }, undefined);
    expect(result).toBeDefined();
    expect(result).toContain("--- FIND ---");
    expect(result).toContain("oldName");
    expect(result).toContain("--- REPLACE ---");
    expect(result).toContain("newName");
  });

  it("returns undefined when find is missing", () => {
    expect(buildToolCallPatch("multi_edit", { replace: "newName", files: [] }, undefined)).toBeUndefined();
  });

  it("returns undefined when replace is missing", () => {
    expect(buildToolCallPatch("multi_edit", { find: "oldName", files: [] }, undefined)).toBeUndefined();
  });
});

describe("buildToolCallPatch — other tools", () => {
  it("returns undefined for read_file", () => {
    expect(buildToolCallPatch("read_file", { filePath: "src/foo.ts" }, undefined)).toBeUndefined();
  });

  it("returns undefined for run_command", () => {
    expect(buildToolCallPatch("run_command", { command: "npm test" }, undefined)).toBeUndefined();
  });

  it("WRITE_FILE_PREVIEW_LINES is less than WRITE_FILE_PATCH_CAP (invariant for DiffView truncation)", () => {
    expect(WRITE_FILE_PREVIEW_LINES).toBeLessThan(WRITE_FILE_PATCH_CAP);
  });
});
