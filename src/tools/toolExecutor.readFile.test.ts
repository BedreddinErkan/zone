/**
 * Phase S.2 tests: read_file tier transitions, line-number prefix, apply_patch compat.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

function makeFile(name: string, content: string): string {
  const abs = path.join(repoPath, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return name;
}

// Generate content guaranteed to exceed targetChars, with lineCount lines.
function makeBigContent(lineCount: number, targetChars: number): string {
  const extraPerLine = Math.ceil((targetChars - lineCount) / lineCount) + 5;
  return Array.from(
    { length: lineCount },
    (_, i) => `const v_${String(i).padStart(3, "0")} = "${String(i).padStart(extraPerLine)}";`
  ).join("\n");
}

// Verify that a line has a line-number prefix by splitting on the tab character.
// Returns the number before the tab, or null if no tab found.
function extractLineNum(line: string): number | null {
  const tabIdx = line.indexOf("\t");
  if (tabIdx === -1) return null;
  const numStr = line.slice(0, tabIdx).trim();
  const n = parseInt(numStr, 10);
  return isNaN(n) ? null : n;
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-s2-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ─── Tier: ≤10K — full content, no line numbers ─────────────────────────────

describe("read_file ≤10K tier (S.2)", () => {
  it("returns full content with no line-number prefix", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `const x${i} = ${i};`).join("\n");
    makeFile("small.ts", content);
    const result = await executeTool("read_file", { filePath: "small.ts", lineRange: null }, repoPath);
    expect(result.success).toBe(true);
    expect(result.output).toBe(content);
  });

  it("first line does NOT start with a digit (no prefix for small files)", async () => {
    makeFile("code.ts", "const x = 1;\nconst y = 2;\n");
    const result = await executeTool("read_file", { filePath: "code.ts", lineRange: null }, repoPath);
    expect(result.success).toBe(true);
    expect(result.output.startsWith("const")).toBe(true);
  });

  it("file at exactly 10000 chars stays in full-content tier", async () => {
    const content = "x".repeat(10_000);
    makeFile("exactly10k.ts", content);
    const result = await executeTool("read_file", { filePath: "exactly10k.ts", lineRange: null }, repoPath);
    expect(result.success).toBe(true);
    expect(result.output).toBe(content);
    expect(result.output).not.toContain("FILE OUTLINE");
  });
});

// ─── Tier: >10K — outline + numbered head/tail ───────────────────────────────

describe("read_file >10K outline tier (S.2)", () => {
  it("returns FILE OUTLINE header for files just over 10K", async () => {
    const bigContent = makeBigContent(300, 12_000);
    expect(bigContent.length).toBeGreaterThan(10_000);
    makeFile("medium.ts", bigContent);
    const result = await executeTool("read_file", { filePath: "medium.ts", lineRange: null }, repoPath);
    expect(result.success).toBe(true);
    expect(result.output).toContain("FILE OUTLINE");
    expect(result.output).toContain("HEAD: lines 1-");
  });

  it("head lines have line-number prefix (verified via tab split)", async () => {
    const bigContent = makeBigContent(300, 12_000);
    makeFile("numbered.ts", bigContent);
    const result = await executeTool("read_file", { filePath: "numbered.ts", lineRange: null }, repoPath);
    expect(result.success).toBe(true);
    // Locate the HEAD section
    const headMarker = "HEAD: lines 1-";
    const headIdx = result.output.indexOf(headMarker);
    expect(headIdx).toBeGreaterThan(-1);
    // Lines after the HEAD section header
    const linesAfterHeader = result.output.slice(headIdx).split("\n");
    // linesAfterHeader[0] = "HEAD: lines 1-100 ───" (or similar)
    // linesAfterHeader[1] = first numbered content line
    const firstContentLine = linesAfterHeader[1] ?? "";
    expect(firstContentLine).toContain("const v_000");
    // Line number prefix: split on tab → first part trims to "1"
    expect(extractLineNum(firstContentLine)).toBe(1);
    // Line 100 (index 100 in the after-header array):
    const line100 = linesAfterHeader[100] ?? "";
    expect(line100).toContain("const v_099");
    expect(extractLineNum(line100)).toBe(100);
  });

  it("tail lines have correct line numbers (verified via tab split)", async () => {
    const lineCount = 300;
    const bigContent = makeBigContent(lineCount, 12_000);
    makeFile("tail_test.ts", bigContent);
    const result = await executeTool("read_file", { filePath: "tail_test.ts", lineRange: null }, repoPath);
    expect(result.success).toBe(true);
    // Locate the TAIL section
    const tailMarker = "TAIL: lines 251-300";
    expect(result.output).toContain(tailMarker);
    const tailIdx = result.output.indexOf(tailMarker);
    const linesAfterTailHeader = result.output.slice(tailIdx).split("\n");
    // First tail content line is line 251
    const firstTailLine = linesAfterTailHeader[1] ?? "";
    expect(firstTailLine).toContain("const v_250");
    expect(extractLineNum(firstTailLine)).toBe(251);
    // Last tail content line is line 300
    const lastTailLine = linesAfterTailHeader[50] ?? "";
    expect(lastTailLine).toContain("const v_299");
    expect(extractLineNum(lastTailLine)).toBe(300);
  });

  it("outline section contains symbol names with line numbers", async () => {
    // 7 leading lines + 400 padding lines with long content = well over 10K
    const padding = Array.from(
      { length: 400 },
      (_, i) => "// padding line " + String(i).padStart(3) + " " + "x".repeat(20)
    );
    const tsContent = [
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "export function beta(x: number) {",
      "  return x * 2;",
      "}",
      ...padding,
    ].join("\n");
    expect(tsContent.length).toBeGreaterThan(10_000);
    makeFile("outline_test.ts", tsContent);
    const result = await executeTool("read_file", { filePath: "outline_test.ts", lineRange: null }, repoPath);
    expect(result.success).toBe(true);
    // generateFileOutline emits "(line N)" for each symbol
    expect(result.output).toContain("alpha");
    expect(result.output).toMatch(/alpha.*\(line 1\)/);
    expect(result.output).toContain("beta");
    expect(result.output).toMatch(/beta.*\(line 5\)/);
  });

  it("no tail section when all lines fit in head (≤100 lines)", async () => {
    // 80 lines, each ~155 chars = ~12,400 chars > 10K — but only 80 lines, all fit in head
    const content = Array.from(
      { length: 80 },
      (_, i) => "const v" + i + " = \"" + "x".repeat(140) + "\";"
    ).join("\n");
    expect(content.length).toBeGreaterThan(10_000);
    makeFile("few_long_lines.ts", content);
    const result = await executeTool("read_file", { filePath: "few_long_lines.ts", lineRange: null }, repoPath);
    expect(result.success).toBe(true);
    expect(result.output).toContain("FILE OUTLINE");
    // tailStartIdx = max(80, 80-50) = 80 → tailLines = [] → no TAIL section
    expect(result.output).not.toContain("TAIL:");
  });
});

// ─── lineRange — numbered slice ──────────────────────────────────────────────

describe("read_file lineRange with line-number prefix (S.2)", () => {
  it("lineRange slice has line numbers starting at the requested offset", async () => {
    const content = Array.from({ length: 300 }, (_, i) => "line_" + (i + 1) + "_content").join("\n");
    makeFile("lr_test.ts", content);
    const result = await executeTool(
      "read_file",
      { filePath: "lr_test.ts", lineRange: [100, 105] },
      repoPath
    );
    expect(result.success).toBe(true);
    const outputLines = result.output.split("\n");
    // Find line containing "line_100_content"
    const line100 = outputLines.find((l) => l.includes("line_100_content")) ?? "";
    expect(extractLineNum(line100)).toBe(100);
    const line105 = outputLines.find((l) => l.includes("line_105_content")) ?? "";
    expect(extractLineNum(line105)).toBe(105);
    expect(result.output).not.toContain("line_99_content");
  });

  it("lineRange header shows the requested range", async () => {
    const content = Array.from({ length: 50 }, (_, i) => "l" + i).join("\n");
    makeFile("lr_header.ts", content);
    const result = await executeTool(
      "read_file",
      { filePath: "lr_header.ts", lineRange: [5, 10] },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("[lineRange 5-10 of 50 total lines from lr_header.ts]");
  });

  it("lineRange on a small file also returns numbered lines", async () => {
    makeFile("small_lr.ts", "alpha\nbeta\ngamma\ndelta\nepsilon\n");
    const result = await executeTool(
      "read_file",
      { filePath: "small_lr.ts", lineRange: [2, 4] },
      repoPath
    );
    expect(result.success).toBe(true);
    const outputLines = result.output.split("\n");
    const betaLine = outputLines.find((l) => l.includes("beta")) ?? "";
    const gammaLine = outputLines.find((l) => l.includes("gamma")) ?? "";
    const deltaLine = outputLines.find((l) => l.includes("delta")) ?? "";
    expect(extractLineNum(betaLine)).toBe(2);
    expect(extractLineNum(gammaLine)).toBe(3);
    expect(extractLineNum(deltaLine)).toBe(4);
  });
});

// ─── apply_patch compat ──────────────────────────────────────────────────────

describe("apply_patch prefix stripping (S.2)", () => {
  it("FIND with line-number prefix still matches — apply succeeds", async () => {
    makeFile("patch_target.ts", "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n");

    // Simulate what an agent copies from a lineRange read (all lines prefixed with tab)
    const TAB = "\t";
    const prefixedFind = "     1" + TAB + "const alpha = 1;\n     2" + TAB + "const beta = 2;";
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "patch_target.ts",
        patch: "--- FIND ---\n" + prefixedFind + "\n--- REPLACE ---\nconst alpha = 10;\nconst beta = 20;",
        intent: "modify",
        scope: null,
      },
      repoPath
    );
    expect(result.success).toBe(true);
    const patched = fs.readFileSync(path.join(repoPath, "patch_target.ts"), "utf8");
    expect(patched).toContain("const alpha = 10;");
    expect(patched).toContain("const beta = 20;");
  });

  it("FIND without prefix still matches — no regression", async () => {
    makeFile("no_prefix.ts", "const x = 1;\nconst y = 2;\n");
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "no_prefix.ts",
        patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 99;",
        intent: "modify",
        scope: null,
      },
      repoPath
    );
    expect(result.success).toBe(true);
    const patched = fs.readFileSync(path.join(repoPath, "no_prefix.ts"), "utf8");
    expect(patched).toContain("const x = 99;");
  });

  it("FIND with mixed prefix/no-prefix is NOT stripped (all-or-nothing rule)", async () => {
    makeFile("mixed.ts", "const a = 1;\nconst b = 2;\n");
    // Only first line has prefix — should NOT be stripped → match fails
    const TAB = "\t";
    const mixedFind = "     1" + TAB + "const a = 1;\nconst b = 2;";
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "mixed.ts",
        patch: "--- FIND ---\n" + mixedFind + "\n--- REPLACE ---\nconst a = 10;\nconst b = 20;",
        intent: "modify",
        scope: null,
      },
      repoPath
    );
    expect(result.success).toBe(false);
  });

  it("single-line FIND with prefix is stripped and matches", async () => {
    makeFile("single.ts", "export const FOO = 42;\n");
    const TAB = "\t";
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "single.ts",
        patch: "--- FIND ---\n     1" + TAB + "export const FOO = 42;\n--- REPLACE ---\nexport const FOO = 99;",
        intent: "modify",
        scope: null,
      },
      repoPath
    );
    expect(result.success).toBe(true);
    const patched = fs.readFileSync(path.join(repoPath, "single.ts"), "utf8");
    expect(patched).toContain("export const FOO = 99;");
  });
});
