import { describe, it, expect } from "vitest";
import {
  getToolDisplayName,
  formatToolArgs,
  getStatusGlyph,
  shouldShowPreview,
  formatMetadata,
  formatPreview,
} from "./toolCallFormat.js";

describe("getToolDisplayName", () => {
  it.each([
    ["read_file", "Read"],
    ["run_command", "Bash"],
    ["run_command_background", "Bash"],
    ["run_command_readonly", "Bash"],
    ["apply_patch", "Edit"],
    ["write_file", "Write"],
    ["list_files", "LS"],
    ["search_in_files", "Grep"],
    ["find_references", "Grep"],
    ["Task", "Task"],
    ["update_memory", "Memory"],
    ["unknown_xyz", "unknown_xyz"],
  ])("maps %s → %s", (raw, expected) => {
    expect(getToolDisplayName(raw)).toBe(expected);
  });
});

describe("formatToolArgs", () => {
  it("returns args unchanged when short", () => {
    expect(formatToolArgs("read_file", "src/foo.ts")).toBe("src/foo.ts");
  });

  it("truncates args at 60 chars with ellipsis", () => {
    const long = "a".repeat(70);
    const result = formatToolArgs("run_command", long);
    expect(result.length).toBe(60);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty string unchanged", () => {
    expect(formatToolArgs("list_files", "")).toBe("");
  });
});

describe("getStatusGlyph", () => {
  it("null (pending) → ○ with no color", () => {
    const g = getStatusGlyph(null);
    expect(g.icon).toBe("○");
    expect(g.color).toBeUndefined();
  });

  it("blocked → ⚠ yellow", () => {
    const g = getStatusGlyph({ ok: false, detail: "blocked reason", blocked: true });
    expect(g.icon).toBe("⚠");
    expect(g.color).toBe("yellow");
  });

  it("ok=false (fail) → ✗ red", () => {
    const g = getStatusGlyph({ ok: false, detail: "error msg" });
    expect(g.icon).toBe("✗");
    expect(g.color).toBe("red");
  });

  it("ok=true (success) → ● no color", () => {
    const g = getStatusGlyph({ ok: true, detail: "done" });
    expect(g.icon).toBe("●");
    expect(g.color).toBeUndefined();
  });
});

describe("shouldShowPreview", () => {
  it("null (pending) → false", () => {
    expect(shouldShowPreview("run_command", null)).toBe(false);
  });

  it("read_file success → false (boring)", () => {
    expect(shouldShowPreview("read_file", { ok: true, detail: "content" })).toBe(false);
  });

  it("list_files success → false (boring)", () => {
    expect(shouldShowPreview("list_files", { ok: true, detail: "files" })).toBe(false);
  });

  it("run_command success → true", () => {
    expect(shouldShowPreview("run_command", { ok: true, detail: "output" })).toBe(true);
  });

  it("apply_patch success → true", () => {
    expect(shouldShowPreview("apply_patch", { ok: true, detail: "patched" })).toBe(true);
  });

  it("read_file fail → true (always show errors)", () => {
    expect(shouldShowPreview("read_file", { ok: false, detail: "not found" })).toBe(true);
  });

  it("any tool blocked → true", () => {
    expect(shouldShowPreview("run_command", { ok: false, detail: "denied", blocked: true })).toBe(true);
  });
});

describe("formatMetadata", () => {
  it("read_file success → 'N lines'", () => {
    const result = formatMetadata("read_file", { ok: true, detail: "line1\nline2\nline3" });
    expect(result).toBe("3 lines");
  });

  it("read_file success with 1 line → singular 'line'", () => {
    const result = formatMetadata("read_file", { ok: true, detail: "single line" });
    expect(result).toBe("1 line");
  });

  it("list_files success → 'N files'", () => {
    const result = formatMetadata("list_files", { ok: true, detail: "file1.ts\nfile2.ts" });
    expect(result).toBe("2 files");
  });

  it("run_command success → null", () => {
    expect(formatMetadata("run_command", { ok: true, detail: "output" })).toBeNull();
  });

  it("read_file fail → null", () => {
    expect(formatMetadata("read_file", { ok: false, detail: "error" })).toBeNull();
  });

  it("null result → null", () => {
    expect(formatMetadata("read_file", null)).toBeNull();
  });
});

describe("formatPreview", () => {
  it("returns first non-empty line", () => {
    expect(formatPreview({ ok: true, detail: "line1\nline2\nline3" })).toBe("line1");
  });

  it("skips leading empty lines", () => {
    expect(formatPreview({ ok: true, detail: "\n\nfirst real line\nother" })).toBe("first real line");
  });

  it("truncates at maxWidth", () => {
    const long = "x".repeat(100);
    const result = formatPreview({ ok: true, detail: long }, 40);
    expect(result?.length).toBe(40);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("returns null for empty detail", () => {
    expect(formatPreview({ ok: true, detail: "" })).toBeNull();
  });

  it("returns null for whitespace-only detail", () => {
    expect(formatPreview({ ok: false, detail: "   \n  \n" })).toBeNull();
  });
});

describe("formatPreview meta filter", () => {
  it("skips [exit_code=0 — ...] line and returns first real line", () => {
    const r = { ok: true, detail: "[exit_code=0 — command succeeded; output below is informational]\nreal output" };
    expect(formatPreview(r)).toBe("real output");
  });

  it("skips [zone-...] lines and returns first non-meta line", () => {
    const r = { ok: false, detail: "[exit_code=1 — command failed]\n[zone-verify-classification] likely_no_matches\nERR: actual error" };
    expect(formatPreview(r)).toBe("ERR: actual error");
  });

  it("returns null when only meta lines present", () => {
    const r = { ok: true, detail: "[exit_code=0 — command succeeded; output below is informational]" };
    expect(formatPreview(r)).toBeNull();
  });

  it("passes through non-meta lines unchanged", () => {
    const r = { ok: true, detail: "regular output line" };
    expect(formatPreview(r)).toBe("regular output line");
  });
});
