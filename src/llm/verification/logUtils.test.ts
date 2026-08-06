/**
 * didApplyPatch reads structured success/filesStaged instead of string-matching
 * result text. Every fixture below uses the real output shape from
 * toolExecutor.ts's write-tool handlers or scopeGuard.ts, not invented text —
 * this is what makes the string-matching version of this function wrong.
 */
import { describe, expect, it } from "vitest";
import { didApplyPatch } from "./logUtils.js";

describe("didApplyPatch — structured success/filesStaged, not prose", () => {
  it("apply_patch success whose path contains \"error\" counts as applied", () => {
    // Real shape: apply_patch's accept-write return, toolExecutor.ts —
    // `Patch staged: ${blocks.length} block(s) in ${filePath}`.
    const result = didApplyPatch([
      {
        tool: "apply_patch",
        args: {},
        result: "Patch staged: 1 block(s) in src/core/parseVerificationError.ts",
        success: true,
      },
    ]);
    expect(result).toBe(true);
  });

  it("write_file success whose path contains \"fail\" counts as applied", () => {
    // Real shape: write_file's new-file accept return, toolExecutor.ts —
    // `Created ${filePath} (${content.length} chars)`.
    const result = didApplyPatch([
      {
        tool: "write_file",
        args: {},
        result: "Created src/core/buildRetryGuidanceFromFailure.ts (512 chars)",
        success: true,
      },
    ]);
    expect(result).toBe(true);
  });

  it("multi_edit-only run with real replacements and non-empty filesStaged counts", () => {
    // Real shape: multi_edit's success return, toolExecutor.ts —
    // `multi_edit: N replacement(s) across M file(s).` + per-file lines.
    const result = didApplyPatch([
      {
        tool: "multi_edit",
        args: {},
        result:
          "multi_edit: 4 replacement(s) across 2 file(s).\n" +
          "  src/a.ts: 2 replacement(s)\n" +
          "  src/b.ts: 2 replacement(s)",
        success: true,
        filesStaged: ["src/a.ts", "src/b.ts"],
      },
    ]);
    expect(result).toBe(true);
  });

  it("multi_edit with success:true and empty filesStaged does not count", () => {
    // Real shape: multi_edit's zero-match return (find string present in no
    // file), toolExecutor.ts — filesStaged only ever gets pushed inside the
    // count>0 branch, so a zero-match call returns success:true with [].
    const result = didApplyPatch([
      {
        tool: "multi_edit",
        args: {},
        result:
          "multi_edit: 0 replacement(s) across 1 file(s).\n" +
          "  src/x.ts: 0 replacement(s)\n" +
          "Note: \"oldThing\" was not found in: src/x.ts",
        success: true,
        filesStaged: [],
      },
    ]);
    expect(result).toBe(false);
  });

  it("a scope-guard block no longer counts as applied", () => {
    // Real shape: checkWriteScope's out-of-plan-scope rejection, scopeGuard.ts.
    const result = didApplyPatch([
      {
        tool: "apply_patch",
        args: {},
        result:
          'Write blocked: "src/x.ts" is outside the planned scope. ' +
          "The plan covers: src/y.ts. If this file genuinely needs editing, " +
          "complete the planned work first and the user can request a follow-up.",
        success: false,
      },
    ]);
    expect(result).toBe(false);
  });

  it("a marker-imbalance rejection no longer counts as applied", () => {
    // Real shape: apply_patch's marker-imbalance rejection, toolExecutor.ts.
    const result = didApplyPatch([
      {
        tool: "apply_patch",
        args: {},
        result:
          "Your patch has 3 `--- FIND ---` marker(s) but 2 `--- REPLACE ---` marker(s). " +
          "Markers must be balanced: every `--- FIND ---` must be paired with exactly one `--- REPLACE ---`.",
        success: false,
      },
    ]);
    expect(result).toBe(false);
  });

  it("an empty log is false", () => {
    expect(didApplyPatch([])).toBe(false);
  });
});

// item 12's remaining half: a succeeding apply_patch/write_file that staged
// byte-identical content (a FIND==REPLACE no-op) still reported "applied"
// because the arm read only `success`. These four fixtures pin the field's
// three-way meaning: absent, empty, populated.
describe("didApplyPatch — apply_patch/write_file no-op detection via filesStaged", () => {
  it("apply_patch success:true with empty filesStaged does not count", () => {
    const result = didApplyPatch([
      {
        tool: "apply_patch",
        args: {},
        result: "Patch staged: 1 block(s) in src/x.ts",
        success: true,
        filesStaged: [],
      },
    ]);
    expect(result).toBe(false);
  });

  it("write_file success:true with empty filesStaged does not count", () => {
    const result = didApplyPatch([
      {
        tool: "write_file",
        args: {},
        result: "Wrote src/x.ts (42 chars)",
        success: true,
        filesStaged: [],
      },
    ]);
    expect(result).toBe(false);
  });

  // Load-bearing: a later sweep unifying this arm's absent-field polarity
  // with multiEditChangedSomething's (which marks-and-returns-false on
  // absent) must fail here rather than pass silently. apply_patch/write_file
  // have a real absent-field producer — rehydrateFileAccess on resume
  // (agentLoop.ts) — that multi_edit does not.
  it("apply_patch success:true with filesStaged absent still counts (absent means changed, not multi_edit's polarity)", () => {
    const result = didApplyPatch([
      {
        tool: "apply_patch",
        args: {},
        result: "Patch staged: 1 block(s) in src/x.ts",
        success: true,
      },
    ]);
    expect(result).toBe(true);
  });

  it("apply_patch success:true with populated filesStaged counts", () => {
    const result = didApplyPatch([
      {
        tool: "apply_patch",
        args: {},
        result: "Patch staged: 1 block(s) in src/a.ts",
        success: true,
        filesStaged: ["src/a.ts"],
      },
    ]);
    expect(result).toBe(true);
  });
});
