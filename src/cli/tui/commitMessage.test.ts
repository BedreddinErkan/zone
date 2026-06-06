import { describe, it, expect } from "vitest";
import { deriveCommitMessage, shouldAutoCommit } from "./commitMessage.js";

describe("deriveCommitMessage", () => {
  it("strips backticks", () => {
    expect(deriveCommitMessage("Added `omit<T>` utility")).toBe("Added omit<T> utility");
  });

  it("preserves snake_case identifiers — underscores never stripped", () => {
    expect(deriveCommitMessage("Created DOGFOOD_AUTO_TEST.md")).toBe("Created DOGFOOD_AUTO_TEST.md");
  });

  it("preserves snake_case in file paths and rename descriptions", () => {
    expect(deriveCommitMessage("rename my_old_name to my_new_name")).toBe("rename my_old_name to my_new_name");
  });

  it("preserves * in arithmetic and **kwargs expressions", () => {
    expect(deriveCommitMessage("a * b multiplication and **kwargs support")).toBe("a * b multiplication and **kwargs support");
  });

  it("preserves glob patterns with *", () => {
    expect(deriveCommitMessage("Added **/*.ts to include path")).toBe("Added **/*.ts to include path");
  });

  it("skips ## heading lines and uses next usable line", () => {
    const input = "## What changed\n- Added auth module";
    expect(deriveCommitMessage(input)).toBe("Added auth module");
  });

  it("skips --- separator lines", () => {
    const input = "---\nFixed the bug";
    expect(deriveCommitMessage(input)).toBe("Fixed the bug");
  });

  it("strips leading - bullet markers", () => {
    expect(deriveCommitMessage("- Added auth module in src/auth.ts")).toBe("Added auth module in src/auth.ts");
  });

  it("strips leading * bullet markers", () => {
    expect(deriveCommitMessage("* Updated barrel export")).toBe("Updated barrel export");
  });

  it("trims at word boundary ≤72, not mid-word", () => {
    // 74-char line; last space before 72 is before "entire"
    const long = "Added a new utility function that performs some operation across the entire";
    expect(long.length).toBeGreaterThan(72);
    const result = deriveCommitMessage(long);
    expect(result.length).toBeLessThanOrEqual(72);
    // The character immediately after the cut in the original must be a space
    // (proving we cut at a word boundary, not mid-word)
    expect(long[result.length]).toBe(" ");
    // Explicitly: "entire" must not appear (it would if we cut at char 72 mid-word)
    expect(result).not.toContain("entir");
  });

  it("returns the full line when it fits within 72 chars", () => {
    const short = "fix: update auth module export";
    expect(deriveCommitMessage(short)).toBe(short);
  });

  it("falls back to 'Run completed' when all lines are headings or empty", () => {
    const input = "## What changed\n## Why\n---\n";
    expect(deriveCommitMessage(input)).toBe("Run completed");
  });

  it("falls back to 'Run completed' for empty string", () => {
    expect(deriveCommitMessage("")).toBe("Run completed");
  });

  it("does not leave dangling backtick from stripped inline code", () => {
    // Dogfood regression: "`foo`" mid-word cut left unclosed backtick
    const input = "Added `omit<T, K>` utility to `src/utils/omit.ts` with type-safe key removal";
    const result = deriveCommitMessage(input);
    expect(result).not.toContain("`");
  });
});

describe("shouldAutoCommit gate", () => {
  const okResult = { ok: true, fileDiffs: [{ filePath: "src/a.ts" }] };

  it("true when all three conditions met", () => {
    expect(shouldAutoCommit(okResult, true)).toBe(true);
  });

  it("false when commitOnSuccess is false", () => {
    expect(shouldAutoCommit(okResult, false)).toBe(false);
  });

  it("false when runResult is undefined", () => {
    expect(shouldAutoCommit(undefined, true)).toBe(false);
  });

  it("false when ok is false", () => {
    expect(shouldAutoCommit({ ok: false, fileDiffs: [{ filePath: "src/a.ts" }] }, true)).toBe(false);
  });

  it("false when fileDiffs is empty", () => {
    expect(shouldAutoCommit({ ok: true, fileDiffs: [] }, true)).toBe(false);
  });

  it("false when fileDiffs is missing", () => {
    expect(shouldAutoCommit({ ok: true }, true)).toBe(false);
  });
});
