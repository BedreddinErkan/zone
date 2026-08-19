import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "./App.js";
import { glyph } from "./theme.js";

/**
 * The slash palette's selection marker. Before this pass it was `role.accent` on the command name
 * and nothing else — real, but the weakest marker of any list in the tree (six modals use
 * role.selectionBackground + role.emphasis; three views use glyph.selectionCursor), and a bare
 * ANSI index colour of exactly the class that rendered wrong in the surface pass.
 *
 * The harness floor below is not ceremony. The first instrument used for this finding was a raw
 * stdin stub that silently delivered no keystrokes at all — every "the palette shows X" claim it
 * produced would have been vacuous. ink-testing-library's own stdin is what actually works, and
 * the first test proves it before any of the others are trusted.
 */

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("harness floor — proven before any palette claim below is trusted", () => {
  it("a '/' keystroke actually reaches the composer and opens the palette", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("/");
    await wait(60);
    expect(lastFrame() ?? "").toContain("/help");
    unmount();
  });
});

describe("slash palette — selection is marked structurally, not by colour alone", () => {
  it("puts the selection cursor on the selected row and only that row", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("/");
    await wait(60);

    const frame = lastFrame() ?? "";
    const cursorRows = frame.split("\n").filter((l) => l.includes(glyph.selectionCursor.trim()));
    expect(cursorRows).toHaveLength(1);
    // Default selection is index 0, which is /help.
    expect(cursorRows[0]).toContain("/help");
    unmount();
  });

  it("moves the cursor with ArrowDown — the marker tracks real selection state", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("/");
    await wait(60);
    stdin.write("\x1b[B");
    await wait(60);

    const frame = lastFrame() ?? "";
    const cursorRows = frame.split("\n").filter((l) => l.includes(glyph.selectionCursor.trim()));
    expect(cursorRows).toHaveLength(1);
    expect(cursorRows[0]).not.toContain("/help");
    unmount();
  });

  /**
   * Unselected rows are padded by the cursor's own width so the command names stay in one column.
   * Without this the whole list shifts horizontally as the selection moves, which reads as noise.
   */
  it("keeps every command name in the same column whether selected or not", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("/");
    await wait(60);

    const frame = lastFrame() ?? "";
    // Anchored on the palette's own border character: StatusBar's right-hand hint also contains
    // "/help", and matching it here made an earlier version of this test fail against correctly
    // aligned output.
    const rows = frame.split("\n").filter((l) => l.startsWith("│") && /\s\/(help|exit|clear|cost)\b/.test(l));
    expect(rows.length).toBeGreaterThan(1);
    const columns = rows.map((l) => l.indexOf("/"));
    expect(new Set(columns).size).toBe(1);
    unmount();
  });
});
