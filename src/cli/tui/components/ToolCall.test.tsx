import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ToolCall } from "./ToolCall.js";

const SUCCESS = [{ ok: true, detail: "ok" }];
const FAIL    = [{ ok: false, detail: "error" }];

const WRITE_FILE_PATCH = "--- FIND ---\n\n--- REPLACE ---\nconst x = 1;\nconst y = 2;";
const APPLY_PATCH_PATCH = "--- FIND ---\nold line\n--- REPLACE ---\nnew line";
const MULTI_EDIT_PATCH = "--- FIND ---\noldName\n--- REPLACE ---\nnewName";

describe("ToolCall — DiffView rendering", () => {
  it("apply_patch with patch renders DiffView (regression guard)", () => {
    const { lastFrame } = render(
      <ToolCall toolName="apply_patch" args="src/foo.ts" results={SUCCESS} patch={APPLY_PATCH_PATCH} />
    );
    const frame = lastFrame() ?? "";
    // Red removal lines (old) and green addition lines (new)
    expect(frame).toContain("old line");
    expect(frame).toContain("new line");
    expect(frame).toContain("+");
    expect(frame).toContain("-");
  });

  it("write_file with patch renders green '+' addition lines", () => {
    const { lastFrame } = render(
      <ToolCall toolName="write_file" args="src/new.ts" results={SUCCESS} patch={WRITE_FILE_PATCH} />
    );
    const frame = lastFrame() ?? "";
    // New-file patch has empty FIND → only green additions
    expect(frame).toContain("+ ");
    expect(frame).toContain("const x = 1;");
    expect(frame).toContain("const y = 2;");
  });

  it("write_file without patch does NOT render DiffView", () => {
    const { lastFrame } = render(
      <ToolCall toolName="write_file" args="src/new.ts" results={SUCCESS} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("+ ");
    expect(frame).not.toContain("--- FIND");
  });

  it("multi_edit with patch renders DiffView find/replace", () => {
    const { lastFrame } = render(
      <ToolCall toolName="multi_edit" args="3 files" results={SUCCESS} patch={MULTI_EDIT_PATCH} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("- ");
    expect(frame).toContain("oldName");
    expect(frame).toContain("+ ");
    expect(frame).toContain("newName");
  });

  it("write_file with long patch shows truncation indicator via maxLines cap", () => {
    // Build a patch with more lines than WRITE_FILE_PREVIEW_LINES (7)
    const manyLines = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const longPatch = `--- FIND ---\n\n--- REPLACE ---\n${manyLines}`;
    const { lastFrame } = render(
      <ToolCall toolName="write_file" args="src/big.ts" results={SUCCESS} patch={longPatch} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("more line");  // the "… +N more lines" indicator
  });

  it("failed write_file does NOT render DiffView", () => {
    const { lastFrame } = render(
      <ToolCall toolName="write_file" args="src/new.ts" results={FAIL} patch={WRITE_FILE_PATCH} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("const x = 1;");
  });

  it("apply_patch without patch does NOT render DiffView", () => {
    const { lastFrame } = render(
      <ToolCall toolName="apply_patch" args="src/foo.ts" results={SUCCESS} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("--- FIND");
  });
});
