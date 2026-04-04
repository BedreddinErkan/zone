import { describe, expect, it, vi } from "vitest";
import { c } from "./colors.js";
import { renderColoredDiff, renderDiffSummary } from "./diffOutput.js";

describe("diffOutput", () => {
  it("renders added lines in green", () => {
    const output = renderColoredDiff("", "hello", "src/file.ts");
    expect(output).toContain(`${c.green}+ hello${c.reset}`);
  });

  it("renders removed lines in red", () => {
    const output = renderColoredDiff("hello", "", "src/file.ts");
    expect(output).toContain(`${c.red}- hello${c.reset}`);
  });

  it("renders unchanged lines in gray", () => {
    const output = renderColoredDiff("same", "same", "src/file.ts");
    expect(output).toContain(`${c.dim}${c.gray}  same${c.reset}`);
  });

  it("handles empty original as all lines added", () => {
    const output = renderColoredDiff("", "a\nb", "src/file.ts");
    expect(output).toContain(`${c.green}+ a${c.reset}`);
    expect(output).toContain(`${c.green}+ b${c.reset}`);
  });

  it("handles empty new content as all lines removed", () => {
    const output = renderColoredDiff("a\nb", "", "src/file.ts");
    expect(output).toContain(`${c.red}- a${c.reset}`);
    expect(output).toContain(`${c.red}- b${c.reset}`);
  });

  it("shows file path in header", () => {
    const output = renderColoredDiff("a", "b", "src/file.ts");
    expect(output).toContain(`${c.bold}${c.white}--- src/file.ts${c.reset}`);
  });

  it("prints all rendered diffs in renderDiffSummary", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    renderDiffSummary([
      { filePath: "src/file.ts", original: "a", updated: "b" },
    ]);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
