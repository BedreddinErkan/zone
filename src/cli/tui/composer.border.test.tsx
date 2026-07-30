import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Box, Text } from "ink";

// Ghost row = a content row (between top and bottom border) containing only │ and spaces.
// This is the Yoga flex-shrink measurement/rendering mismatch artifact fixed in tui-10-g.
function ghostRows(frame: string): string[] {
  const lines = frame.split("\n");
  // Exclude first and last lines (top/bottom borders)
  return lines.slice(1, -1).filter((l) => /^│\s*│$/.test(l));
}

// The Composer input Box structure under test (mirrors Composer.tsx lines 391–399).
// Using Box+Text directly (not the full App) to isolate border structure.
function InputBox({ buffer, disabled }: { buffer: string; disabled: boolean }): React.ReactElement {
  const prefix = disabled ? "  " : "> ";
  const borderColor = disabled ? "gray" : "white";
  // renderBuffer inserts cursor glyph at end (matches Composer's renderBuffer logic)
  const displayBuffer = disabled ? buffer : buffer + "▋";
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text dimColor={disabled}>{prefix}</Text>
      <Box flexGrow={1}>
        <Text dimColor={disabled}>{displayBuffer}</Text>
        {!disabled && !buffer && <Text dimColor>{"Type a task or /help · /model /commit /resume"}</Text>}
      </Box>
    </Box>
  );
}

describe("TUI.10.G composer border", () => {
  it("single-line input renders 3-row box with no ghost row", () => {
    const { lastFrame } = render(<InputBox buffer="hello world" disabled={false} />);
    const frame = lastFrame() ?? "";
    expect(frame.split("\n")).toHaveLength(3);
    expect(ghostRows(frame)).toHaveLength(0);
  });

  it("2-line explicit-newline input renders 4-row box with no ghost row", () => {
    const buf = "Find every place in src/cli/tui/components/\ncontinued on second line";
    const { lastFrame } = render(<InputBox buffer={buf} disabled={false} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    expect(lines).toHaveLength(4);
    expect(ghostRows(frame)).toHaveLength(0);
    // Both content rows have text (not just borders)
    expect(lines[1]).toMatch(/Find every place/);
    expect(lines[2]).toMatch(/continued/);
  });

  it("near-overflow auto-wrap renders 4-row box with content on both rows", () => {
    // At 100-col terminal: Box content = 96, prefix = 2, cursor = 1
    // bufLen=94 makes displayBuffer=95 chars → total 2+95=97 > 96 by exactly 1
    // (this was the exact case that triggered the ghost-row bug before the fix)
    const buf = "X".repeat(47) + " " + "X".repeat(46); // 94 chars with a word-break space
    const { lastFrame } = render(<InputBox buffer={buf} disabled={false} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    expect(lines).toHaveLength(4);
    expect(ghostRows(frame)).toHaveLength(0);
    // Both content rows have text
    const contentLines = lines.slice(1, -1);
    const nonEmptyContent = contentLines.filter((l) => l.trim() !== "│");
    expect(nonEmptyContent).toHaveLength(2);
  });

  it("empty buffer renders 3-row box with placeholder and no ghost row", () => {
    const { lastFrame } = render(<InputBox buffer="" disabled={false} />);
    const frame = lastFrame() ?? "";
    expect(frame.split("\n")).toHaveLength(3);
    expect(ghostRows(frame)).toHaveLength(0);
    expect(frame).toContain("Type a task or /help");
  });

  it("idle placeholder names at least one command, without adding a row", () => {
    const { lastFrame } = render(<InputBox buffer="" disabled={false} />);
    const frame = lastFrame() ?? "";
    // Structural pin unchanged — a wider hint must still fit a 3-row box.
    expect(frame.split("\n")).toHaveLength(3);
    expect(ghostRows(frame)).toHaveLength(0);
    expect(frame).toContain("Type a task or /help");
    expect(frame).toMatch(/\/(model|commit|resume)/);
  });
});
