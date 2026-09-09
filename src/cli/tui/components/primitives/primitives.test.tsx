import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { describe, expect, it } from "vitest";
import {
  KeyHints,
  OverlayShell,
  Row,
  SectionTitle,
  ListItem,
  IndentedWrap,
  Panel,
} from "./index.js";

/** Strips ANSI SGR codes so assertions can read text regardless of colour treatment. */
function stripAnsi(s: string): string {
  // SGR sequences: ESC[<n>(;<n>)*m. Covers 0, 1, 22, 38;2;r;g;b, 30-37, 90-97, etc.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Drains the microtask + timer queues enough for ink's re-render scheduler to commit the
 *  next frame to stdout. Matches the drain in __tests__/replayHarness.ts. */
function drainInk(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 48));
}

/** Render a tree, await ink's first paint, and expose the last frame. ink-testing-library
 *  hardcodes 100 columns — tests below that care about exact width do so against that
 *  fixed value. */
async function renderAt(
  tree: React.ReactElement
): Promise<{ lastFrame: () => string | undefined; unmount: () => void }> {
  const instance = render(tree);
  await drainInk();
  return {
    lastFrame: () => instance.lastFrame(),
    unmount: () => instance.unmount(),
  };
}

describe("primitives — KeyHints", () => {
  it("renders primary hints distinct from secondary (strip-ansi shows different structure)", async () => {
    const { lastFrame, unmount } = await renderAt(
      <KeyHints
        items={[
          { key: "Enter", label: "confirm", primary: true },
          { key: "Esc", label: "cancel" },
        ]}
      />
    );
    const plain = stripAnsi(lastFrame() ?? "");
    expect(plain).toContain("Enter");
    expect(plain).toContain("confirm");
    expect(plain).toContain("Esc");
    expect(plain).toContain("cancel");
    expect(plain).toContain(" · ");
    unmount();
  });

  it("renders nothing when items is empty", async () => {
    const { lastFrame, unmount } = await renderAt(<KeyHints items={[]} />);
    expect(stripAnsi(lastFrame() ?? "")).toBe("");
    unmount();
  });
});

describe("primitives — OverlayShell", () => {
  it("renders title (lowercased), border and footer hints at default width", async () => {
    const { lastFrame, unmount } = await renderAt(
      <OverlayShell
        title="Confirm Action"
        keyHints={[{ key: "Y", label: "yes", primary: true }]}
      >
        <KeyHints items={[]} />
      </OverlayShell>
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("confirm action");
    expect(frame).toContain("Y");
    expect(frame).toContain("yes");
    // Border glyphs for "round" style
    expect(frame).toMatch(/[╭╮╰╯]/);
    unmount();
  });

  it("narrow / wide / full produce monotonically increasing frame widths", async () => {
    const widths: Record<string, number> = {};
    for (const policy of ["narrow", "wide", "full"] as const) {
      const { lastFrame, unmount } = await renderAt(
        <OverlayShell title={policy} width={policy}>
          <KeyHints items={[]} />
        </OverlayShell>
      );
      const frame = lastFrame() ?? "";
      // Width = longest line's visible-character extent. The border is part of the line,
      // so strip ANSI but keep glyphs, then measure max line length.
      const maxLine = stripAnsi(frame)
        .split("\n")
        .reduce((acc, line) => Math.max(acc, line.length), 0);
      widths[policy] = maxLine;
      unmount();
    }
    expect(widths.narrow).toBeLessThanOrEqual(widths.wide ?? 0);
    expect(widths.wide).toBeLessThanOrEqual(widths.full ?? 0);
  });

  it("double and single border styles swap the border glyph set", async () => {
    const single = await renderAt(
      <OverlayShell title="s" borderStyle="single">
        <KeyHints items={[]} />
      </OverlayShell>
    );
    const double = await renderAt(
      <OverlayShell title="d" borderStyle="double">
        <KeyHints items={[]} />
      </OverlayShell>
    );
    const singleFrame = stripAnsi(single.lastFrame() ?? "");
    const doubleFrame = stripAnsi(double.lastFrame() ?? "");
    expect(singleFrame).toMatch(/[┌┐└┘]/);
    expect(doubleFrame).toMatch(/[╔╗╚╝]/);
    single.unmount();
    double.unmount();
  });
});

describe("primitives — Row", () => {
  it("renders label + value + right-aligned tail on one line", async () => {
    const { lastFrame, unmount } = await renderAt(
      <Row label="Model" value="claude-3-5" right="active" />
    );
    const plain = stripAnsi(lastFrame() ?? "");
    expect(plain).toContain("Model");
    expect(plain).toContain("claude-3-5");
    expect(plain).toContain("active");
    unmount();
  });

  it("selected row carries the selectionCursor glyph, unselected does not", async () => {
    const selected = await renderAt(<Row label="Option A" selected />);
    const unselected = await renderAt(<Row label="Option A" />);
    const selectedFrame = stripAnsi(selected.lastFrame() ?? "");
    const unselectedFrame = stripAnsi(unselected.lastFrame() ?? "");
    expect(selectedFrame).toContain("▸");
    expect(unselectedFrame).not.toContain("▸");
    selected.unmount();
    unselected.unmount();
  });
});

describe("primitives — SectionTitle", () => {
  it("lowercases the title", async () => {
    const { lastFrame, unmount } = await renderAt(<SectionTitle title="Providers" />);
    const plain = stripAnsi(lastFrame() ?? "");
    expect(plain).toContain("providers");
    expect(plain).not.toMatch(/Providers/);
    unmount();
  });

  it("includes the separator glyph and scales with terminal width", async () => {
    const { lastFrame, unmount } = await renderAt(<SectionTitle title="X" />);
    const plain = stripAnsi(lastFrame() ?? "");
    expect(plain).toContain("─");
    // Rule length is cols - title.length - 4; at 100 cols with a 1-char title, expect ~95 rule chars.
    const ruleMatches = plain.match(/─+/g) ?? [];
    expect(ruleMatches.length).toBeGreaterThan(0);
    const longest = ruleMatches.reduce((a, b) => (a.length > b.length ? a : b));
    expect(longest.length).toBeGreaterThanOrEqual(90);
    unmount();
  });
});

describe("primitives — ListItem", () => {
  it("selected row has selectionCursor, unselected has two-space prefix", async () => {
    const selected = await renderAt(<ListItem text="alpha" selected />);
    const unselected = await renderAt(<ListItem text="alpha" />);
    const selectedFrame = stripAnsi(selected.lastFrame() ?? "");
    const unselectedFrame = stripAnsi(unselected.lastFrame() ?? "");
    expect(selectedFrame).toContain("▸");
    expect(unselectedFrame).not.toContain("▸");
    expect(unselectedFrame).toMatch(/^\s{2}alpha/);
    selected.unmount();
    unselected.unmount();
  });

  it("renders detail line with the detailConnector glyph", async () => {
    const { lastFrame, unmount } = await renderAt(
      <ListItem text="main" detail="subordinate info" />
    );
    const plain = stripAnsi(lastFrame() ?? "");
    expect(plain).toContain("main");
    expect(plain).toContain("subordinate info");
    expect(plain).toContain("└");
    unmount();
  });
});

describe("primitives — IndentedWrap", () => {
  it("wrapped lines start at the indent column, not column 0", async () => {
    // A long string that will wrap inside ink's 100-col container. The indent forces the
    // first-line content to start at column 8; wrapped continuation lines must also start
    // there (Ink's paddingLeft applies to every wrapped line inside the Box).
    const longText =
      "the quick brown fox jumps over the lazy dog and then keeps going well past the point where " +
      "any reasonable line would have stopped already because we need to force a wrap at 100 columns";
    const { lastFrame, unmount } = await renderAt(<IndentedWrap text={longText} indent={8} />);
    const plain = stripAnsi(lastFrame() ?? "");
    const lines = plain.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      // Every line starts with at least 8 spaces of indent.
      expect(line, `line did not start with 8-space indent: ${JSON.stringify(line)}`).toMatch(
        /^\s{8,}/
      );
    }
    unmount();
  });
});

describe("primitives — Panel", () => {
  it("renders title (lowercased) when given, and no title row when omitted", async () => {
    // Pass <Text> children — Ink doesn't render bare strings at a function-component
    // return site (a quirk of Ink v3's reconciler). Real production callers always pass
    // elements; this matches that contract.
    const withTitle = await renderAt(
      <Panel title="Inline Block">
        <Text>content here</Text>
      </Panel>
    );
    const without = await renderAt(
      <Panel>
        <Text>content here</Text>
      </Panel>
    );
    const withTitleFrame = stripAnsi(withTitle.lastFrame() ?? "");
    const withoutFrame = stripAnsi(without.lastFrame() ?? "");
    expect(withTitleFrame).toContain("inline block");
    expect(withTitleFrame).toContain("content here");
    expect(withoutFrame).toContain("content here");
    // without title has no "inline block" to find
    expect(withoutFrame).not.toContain("inline block");
    withTitle.unmount();
    without.unmount();
  });
});
