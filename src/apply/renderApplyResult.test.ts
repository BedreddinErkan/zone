import { describe, expect, it } from "vitest";
import { renderApplyResult } from "./renderApplyResult.js";
import type { ApplyResult } from "./types.js";

describe("renderApplyResult", () => {
  it("renders a non-applied result clearly", () => {
    const result: ApplyResult = {
      applied: false,
      filesChanged: [],
      summary: "Apply confirmation is required."
    };

    const output = renderApplyResult(result);

    expect(output).toContain("=== APPLY RESULT ===");
    expect(output).toContain("Applied: no");
    expect(output).toContain("Summary: Apply confirmation is required.");
    expect(output).not.toContain("Changed files:");
  });

  it("renders an applied result with changed files", () => {
    const result: ApplyResult = {
      applied: true,
      filesChanged: ["src/core/foo.ts", "src/core/bar.ts"],
      summary: "Applied 2 file change(s)."
    };

    const output = renderApplyResult(result);

    expect(output).toContain("=== APPLY RESULT ===");
    expect(output).toContain("Applied: yes");
    expect(output).toContain("Summary: Applied 2 file change(s).");
    expect(output).toContain("Changed files:");
    expect(output).toContain("- src/core/foo.ts");
    expect(output).toContain("- src/core/bar.ts");
  });

  it("does not render changed files section when no files changed", () => {
    const result: ApplyResult = {
      applied: true,
      filesChanged: [],
      summary: "Applied 0 file change(s)."
    };

    const output = renderApplyResult(result);

    expect(output).toContain("Applied: yes");
    expect(output).toContain("Summary: Applied 0 file change(s).");
    expect(output).not.toContain("Changed files:");
  });
});