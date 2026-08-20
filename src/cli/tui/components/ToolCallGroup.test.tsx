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

/**
 * Walks the element tree ToolCallGroup returns directly, not through Ink's terminal renderer.
 * lastFrame() strips ANSI styling under a plain `vitest run` — chalk disables colour without a
 * TTY or FORCE_COLOR, confirmed empirically (no other test in this file asserts on styling for
 * the same reason), and whether FORCE_COLOR happens to be set in the ambient shell is not this
 * suite's concern to depend on. Reading the actual `italic` prop off the Text element is direct
 * and environment-independent, where a string search for an SGR escape code would not be.
 */
function detailLineItalic(calls: ToolCallGroupProps["calls"], arg: string): boolean | undefined {
  const tree = ToolCallGroup({ calls });
  const topChildren = React.Children.toArray((tree.props as { children?: React.ReactNode }).children);
  for (const child of topChildren) {
    if (!React.isValidElement(child)) continue;
    const inner = React.Children.toArray((child.props as { children?: React.ReactNode }).children);
    for (const el of inner) {
      if (!React.isValidElement(el)) continue;
      const elProps = el.props as { italic?: boolean; children?: React.ReactNode };
      const text = React.Children.toArray(elProps.children).join("");
      if (text.includes(arg)) return elProps.italic;
    }
  }
  return undefined;
}

describe("ToolCallGroup — pattern-bearing calls render italic, path-bearing calls do not", () => {
  it("search_in_files and find_references get italic; read_file and list_files do not", () => {
    const calls: ToolCallGroupProps["calls"] = [
      { toolName: "search_in_files", arg: "TODO:" },
      { toolName: "find_references", arg: "someSymbol" },
      { toolName: "read_file", arg: "path/to/file.ts" },
      { toolName: "list_files", arg: "components" },
    ];
    expect(detailLineItalic(calls, "TODO:")).toBe(true);
    expect(detailLineItalic(calls, "someSymbol")).toBe(true);
    expect(detailLineItalic(calls, "path/to/file.ts")).toBe(false);
    expect(detailLineItalic(calls, "components")).toBe(false);
  });
});
