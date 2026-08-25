/**
 * The composer's layout, asserted against the composer.
 *
 * This file was `composer.border.test.tsx` and it built its own local `InputBox` — a rounded-border
 * box whose imports were ink's `Box` and `Text`, never `Composer`. The shipped composer has no
 * border on that box; it carries a background fill. So every assertion described a shape rendered
 * nowhere, and its ghost-row detector (a content row of only box-drawing pipes) could not match a
 * box that draws no pipes. It passed, exercised real Yoga behaviour, and observed nothing.
 *
 * Demonstrated rather than argued: `flexGrow={1}` was removed from the real Composer's buffer box —
 * the exact defect the original file was written for, the one TUI.10 records — and the old file
 * reported 5 passed, 0 failed.
 *
 * Rendered through the real tree via `<App />`, the pattern palette.selection.test.tsx already uses,
 * and specifically NOT through a partial store mock: the mock that hid a missing state field and
 * blanked a whole modal is the standing example of what that shortcut costs.
 */

import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import chalk from "chalk";
import { App } from "./App.js";
import { COMPOSER_PLACEHOLDER } from "./components/Composer.js";
import { role } from "./theme.js";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The composer is the frame's last non-empty row while idle: it sits below the transcript and
 *  above the status bar, and is the only row carrying the input marker. */
function composerRows(frame: string): string[] {
  const lines = frame.split("\n");
  const start = lines.findIndex((l) => l.includes("> "));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && /\$0\.\d|·\s*\d+k tok|elapsed/.test(l));
  return lines.slice(start, end === -1 ? lines.length : end).filter((l) => l.trim() !== "");
}

describe("harness floor — proven before any layout claim below is trusted", () => {
  it("the real composer renders, and this file can find its rows", async () => {
    // Without this the row-count assertions could all pass on an empty list.
    const { lastFrame, unmount } = render(<App />);
    await wait(60);
    const rows = composerRows(lastFrame() ?? "");
    expect(rows.length, "found no composer rows — the locator is broken, not the tree").toBeGreaterThan(0);
    expect(rows.join("\n")).toContain(COMPOSER_PLACEHOLDER);
    unmount();
  });

  it("a keystroke actually reaches the composer", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    await wait(60);
    stdin.write("hello");
    await wait(60);
    expect(lastFrame() ?? "").toContain("hello");
    unmount();
  });
});

describe("composer layout — what ships, not a reconstruction of it", () => {
  it("idle and empty: the marker and the placeholder share ONE row", async () => {
    const { lastFrame, unmount } = render(<App />);
    await wait(60);
    const rows = composerRows(lastFrame() ?? "");
    const withHint = rows.filter((l) => l.includes(COMPOSER_PLACEHOLDER));
    expect(withHint).toHaveLength(1);
    // The marker is on that same row, not pushed onto its own.
    expect(withHint[0]).toContain(">");
    unmount();
  });

  it("a buffer that fits the width stays on one row", async () => {
    // This is what flexGrow={1} on the buffer box buys. Without it the box shrinks to fit and text
    // that comfortably fits the terminal wraps anyway — the TUI.10 width-squeeze defect.
    const typed = "refactor the staging flush so it survives an early exit";
    const { lastFrame, stdin, unmount } = render(<App />);
    await wait(60);
    stdin.write(typed);
    await wait(80);
    const rows = composerRows(lastFrame() ?? "");
    const carrying = rows.filter((l) => l.includes("refactor the staging"));
    expect(carrying, `composer rows were:\n${rows.join("\n")}`).toHaveLength(1);
    expect(carrying[0]).toContain(typed);
    unmount();
  });

  it("the placeholder disappears once anything is typed", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    await wait(60);
    stdin.write("x");
    await wait(60);
    expect(composerRows(lastFrame() ?? "").join("\n")).not.toContain(COMPOSER_PLACEHOLDER);
    unmount();
  });

  it("negative control — the placeholder's WORDING is not what these rows assert", async () => {
    // This control FAILED on the first draft: the locator matched the hint's literal text and the
    // assertions repeated the sentence, so rewording the placeholder broke tests that claim to
    // check layout. Both now read COMPOSER_PLACEHOLDER from Composer.tsx, so a reworded hint moves
    // the assertions with it and the row locator keys on the input marker instead.
    const { lastFrame, unmount } = render(<App />);
    await wait(60);
    expect(composerRows(lastFrame() ?? "").length).toBeGreaterThanOrEqual(1);
    unmount();
  });
});

/**
 * The colour half, with its regime declared.
 *
 * The suite's baseline is chalk level 0, where every colour byte vanishes — so a presence-shaped
 * colour assertion inherited from the ambient shell would FAIL rather than pass vacuously, and an
 * absence-shaped one would pass proving nothing. Level is set here per case, as banner.test.tsx does.
 */
describe("composer foreground actually reaches the frame", () => {
  it("emits role.surfaceForeground's RGB components at truecolor", async () => {
    const prev = chalk.level;
    try {
      chalk.level = 3;
      const { lastFrame, unmount } = render(<App />);
      await wait(60);
      const frame = lastFrame() ?? "";
      // Built from the role, so a value change in theme.ts moves this with it rather than
      // stranding a hardcoded triple — the producer is theme.ts, and there is one source.
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(role.surfaceForeground.slice(i, i + 2), 16));
      expect(frame).toContain(`38;2;${r};${g};${b}`);
      unmount();
    } finally {
      chalk.level = prev;
    }
  });

  it("HARNESS FLOOR: at level 0 that same frame carries no colour at all", async () => {
    // Proves the assertion above is regime-dependent rather than accidentally true, and states the
    // regime under which the absence is meaningless.
    const prev = chalk.level;
    try {
      chalk.level = 0;
      const { lastFrame, unmount } = render(<App />);
      await wait(60);
      expect(lastFrame() ?? "").not.toContain("38;2;");
      unmount();
    } finally {
      chalk.level = prev;
    }
  });
});
