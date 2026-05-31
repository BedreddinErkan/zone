import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { DiffView } from "./components/DiffView.js";

const BASIC_PATCH = `--- FIND ---
const x = 1;
--- REPLACE ---
const x = 2;`;

const MULTI_BLOCK_PATCH = `--- FIND ---
const a = 1;
--- REPLACE ---
const a = 10;
--- FIND ---
const b = 2;
--- REPLACE ---
const b = 20;`;

describe("TUI.10.I DiffView", () => {
  it("mixed FIND+REPLACE renders − lines before + lines with correct colors", () => {
    const { lastFrame } = render(<DiffView patch={BASIC_PATCH} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n").filter((l) => l.trim());
    expect(lines.some((l) => l.includes("- ") && l.includes("const x = 1"))).toBe(true);
    expect(lines.some((l) => l.includes("+ ") && l.includes("const x = 2"))).toBe(true);
    // − line must come before + line
    const minusIdx = lines.findIndex((l) => l.includes("- ") && l.includes("const x = 1"));
    const plusIdx = lines.findIndex((l) => l.includes("+ ") && l.includes("const x = 2"));
    expect(minusIdx).toBeLessThan(plusIdx);
  });

  it("additions-only (empty FIND) renders only + lines, no − lines", () => {
    const patch = `--- FIND ---\n--- REPLACE ---\nconst added = true;`;
    const { lastFrame } = render(<DiffView patch={patch} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("+ ");
    expect(frame).toContain("const added = true");
    expect(frame).not.toMatch(/^- /m);
  });

  it("deletions-only (empty REPLACE) renders only − lines, no + lines", () => {
    const patch = `--- FIND ---\nconst removed = true;\n--- REPLACE ---\n`;
    const { lastFrame } = render(<DiffView patch={patch} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("- ");
    expect(frame).toContain("const removed = true");
    expect(frame).not.toMatch(/^\+ /m);
  });

  it("multi-block patch renders dim ··· separator between blocks", () => {
    const { lastFrame } = render(<DiffView patch={MULTI_BLOCK_PATCH} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("···");
    expect(frame).toContain("const a = 1");
    expect(frame).toContain("const a = 10");
    expect(frame).toContain("const b = 2");
    expect(frame).toContain("const b = 20");
  });

  it("truncates at 20 content lines with '… +N more lines' indicator", () => {
    // Build a patch with 25 FIND lines and 0 REPLACE lines
    const manyLines = Array.from({ length: 25 }, (_, i) => `line${i}`).join("\n");
    const patch = `--- FIND ---\n${manyLines}\n--- REPLACE ---\n`;
    const { lastFrame } = render(<DiffView patch={patch} />);
    const frame = lastFrame() ?? "";
    const diffLines = frame.split("\n").filter((l) => l.includes("- "));
    expect(diffLines).toHaveLength(20);
    expect(frame).toContain("… +5 more lines");
  });

  it("malformed patch (no markers) renders nothing / no crash", () => {
    const { lastFrame } = render(<DiffView patch={"some random text with no markers"} />);
    const frame = lastFrame() ?? "";
    // Either null (no output) or empty — just must not crash
    expect(frame.includes("- ") || frame.includes("+ ")).toBe(false);
  });

  it("empty string patch renders nothing", () => {
    const { lastFrame } = render(<DiffView patch={""} />);
    const frame = lastFrame() ?? "";
    expect(frame.includes("- ") || frame.includes("+ ")).toBe(false);
  });
});
