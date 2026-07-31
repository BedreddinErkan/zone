import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ToolCallGroup, type ToolCallGroupProps } from "./ToolCallGroup.js";

describe("ToolCallGroup — count header + per-call detail lines", () => {
  it("renders the count header for a single-tool batch", () => {
    const calls: ToolCallGroupProps["calls"] = [
      { toolName: "read_file", arg: "a.ts" },
      { toolName: "read_file", arg: "b.ts" },
    ];
    const frame = render(<ToolCallGroup calls={calls} />).lastFrame() ?? "";
    expect(frame).toContain("Read ×2");
  });

  it("renders every call's identifying argument as its own detail line — the whole point of this pass", () => {
    const calls: ToolCallGroupProps["calls"] = [
      { toolName: "read_file", arg: "src/llm/toolEventHandler/handleToolResult.ts" },
      { toolName: "read_file", arg: "src/cli/tui/store-core.ts" },
      { toolName: "search_in_files", arg: "TOOL_RESULT_PUSH" },
    ];
    const frame = render(<ToolCallGroup calls={calls} />).lastFrame() ?? "";
    expect(frame).toContain("src/llm/toolEventHandler/handleToolResult.ts");
    expect(frame).toContain("src/cli/tui/store-core.ts");
    expect(frame).toContain("TOOL_RESULT_PUSH");
  });

  it("a batch mixing tool kinds keeps the header's per-tool counts correct alongside the detail lines", () => {
    const calls: ToolCallGroupProps["calls"] = [
      { toolName: "read_file", arg: "a.ts" },
      { toolName: "search_in_files", arg: "pattern one" },
      { toolName: "search_in_files", arg: "pattern two" },
      { toolName: "find_references", arg: "someSymbol" },
    ];
    const frame = render(<ToolCallGroup calls={calls} />).lastFrame() ?? "";
    // read_file and find_references both display as distinct names; search_in_files
    // and find_references share the "Grep" display name and count together.
    expect(frame).toContain("Read ×1");
    expect(frame).toContain("Grep ×3");
    expect(frame).toContain("a.ts");
    expect(frame).toContain("pattern one");
    expect(frame).toContain("pattern two");
    expect(frame).toContain("someSymbol");
  });

  it("all N calls render, never a truncated subset — the batch is already small by construction", () => {
    const calls: ToolCallGroupProps["calls"] = Array.from({ length: 5 }, (_, i) => ({
      toolName: "read_file",
      arg: `file${i}.ts`,
    }));
    const frame = render(<ToolCallGroup calls={calls} />).lastFrame() ?? "";
    for (let i = 0; i < 5; i++) {
      expect(frame).toContain(`file${i}.ts`);
    }
  });

  it("a call with an empty identifying arg renders no detail line at all — not a blank one", () => {
    const calls: ToolCallGroupProps["calls"] = [
      { toolName: "search_in_files", arg: "" }, // model omitted pattern — the real, observed shape
      { toolName: "read_file", arg: "a.ts" },
      { toolName: "read_file", arg: "b.ts" },
    ];
    const frame = render(<ToolCallGroup calls={calls} />).lastFrame() ?? "";
    const detailLines = frame.split("\n").filter((l) => l.includes("└"));
    expect(detailLines).toHaveLength(2);
    expect(frame).toContain("a.ts");
    expect(frame).toContain("b.ts");
  });
});
