/**
 * Phase J.4 — buildApplyRolledBackMessage shape + heuristic tests.
 */

import { describe, expect, it } from "vitest";
import {
  ROLLED_BACK_SUGGESTIONS,
  applyRolledBackMessageHasSuggestion,
  buildApplyRolledBackMessage,
  isApplyRolledBackMessage,
  parseTscErrorPreview,
  pickRolledBackSuggestion,
} from "./applyRollbackFeedback.js";

describe("Phase J.4 — parseTscErrorPreview", () => {
  it("parses standard tsc error lines into structured rows", () => {
    const preview =
      `src/foo.ts(12,5): error TS2305: Module '"./bar"' has no exported member 'baz'.\n` +
      `src/foo.ts(13,10): error TS2304: Cannot find name 'qux'.`;
    const rows = parseTscErrorPreview(preview);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      file: "src/foo.ts",
      line: 12,
      col: 5,
      code: "TS2305",
    });
    expect(rows[0]!.message).toContain("has no exported member");
    expect(rows[1]).toMatchObject({ code: "TS2304", line: 13 });
  });

  it("surfaces non-tsc lines as raw messages with empty code", () => {
    const preview = `FAIL src/x.test.ts\n  ✗ adds two numbers`;
    const rows = parseTscErrorPreview(preview);
    expect(rows.length).toBe(2);
    expect(rows[0]!.code).toBe("");
    expect(rows[0]!.message).toBe("FAIL src/x.test.ts");
  });

  it("skips empty lines", () => {
    expect(parseTscErrorPreview("").length).toBe(0);
    expect(parseTscErrorPreview("\n\n  \n").length).toBe(0);
  });
});

describe("Phase J.4 — pickRolledBackSuggestion (C2 heuristic)", () => {
  it("returns the TS2305 suggestion when present", () => {
    const errors = [{ code: "TS2305", message: "x" }];
    expect(pickRolledBackSuggestion(errors)).toBe(ROLLED_BACK_SUGGESTIONS.get("TS2305"));
  });

  it("returns the TS2304 suggestion when present", () => {
    expect(pickRolledBackSuggestion([{ code: "TS2304", message: "x" }])).toBe(
      ROLLED_BACK_SUGGESTIONS.get("TS2304"),
    );
  });

  it("returns the TS2339 suggestion when present", () => {
    expect(pickRolledBackSuggestion([{ code: "TS2339", message: "x" }])).toBe(
      ROLLED_BACK_SUGGESTIONS.get("TS2339"),
    );
  });

  it("returns empty string when no error code matches (e.g. TS6133 unused var)", () => {
    expect(pickRolledBackSuggestion([{ code: "TS6133", message: "x" }])).toBe("");
  });

  it("picks the first matching code when mixed", () => {
    const errors = [
      { code: "TS6133", message: "unused" },
      { code: "TS2305", message: "missing export" },
    ];
    // Iteration order matches input — TS6133 has no suggestion, so we fall to TS2305.
    expect(pickRolledBackSuggestion(errors)).toBe(ROLLED_BACK_SUGGESTIONS.get("TS2305"));
  });
});

describe("Phase J.4 — buildApplyRolledBackMessage (C1 shape)", () => {
  it("renders the APPLY_ROLLED_BACK marker, filePath, single error, and restored list", () => {
    const msg = buildApplyRolledBackMessage({
      filePath: "src/foo.ts",
      errors: [{ file: "src/foo.ts", line: 12, col: 5, code: "TS2305", message: "missing 'baz'" }],
      restoredFiles: ["src/foo.ts"],
    });
    expect(isApplyRolledBackMessage(msg)).toBe(true);
    expect(msg).toContain("APPLY_ROLLED_BACK\n");
    expect(msg).toContain("Your apply_patch on src/foo.ts was rolled back.");
    expect(msg).toContain("introduced 1 new error(s):");
    expect(msg).toContain("src/foo.ts(12,5): TS2305: missing 'baz'");
    expect(msg).toContain('Files restored to pre-apply state: ["src/foo.ts"]');
    expect(msg).toContain("Disk is at the pre-apply state. Re-investigate before re-attempting.");
  });

  it("caps at 5 errors and emits '(plus K more)' when more exist", () => {
    const errs = Array.from({ length: 7 }, (_, i) => ({
      file: `src/x${i}.ts`,
      line: i + 1,
      col: 1,
      code: "TS6133",
      message: `error ${i}`,
    }));
    const msg = buildApplyRolledBackMessage({
      filePath: "<multiple>",
      errors: errs,
      restoredFiles: errs.map((e) => e.file!),
    });
    // First 5 rendered, last 2 collapsed.
    for (let i = 0; i < 5; i++) expect(msg).toContain(`src/x${i}.ts(${i + 1},1):`);
    expect(msg).not.toContain("src/x5.ts(6,1):");
    expect(msg).not.toContain("src/x6.ts(7,1):");
    expect(msg).toContain("(plus 2 more)");
    expect(msg).toContain("introduced 7 new error(s):");
  });

  it("appends a suggestion line when at least one error matches the heuristic", () => {
    const msg = buildApplyRolledBackMessage({
      filePath: "src/a.ts",
      errors: [
        { code: "TS6133", message: "unused 'foo'" },
        { code: "TS2305", message: "missing 'bar'" },
      ],
      restoredFiles: ["src/a.ts"],
    });
    expect(msg).toContain("Suggested: the rename is partial");
  });

  it("omits the suggestion block entirely when no error matches the heuristic", () => {
    const msg = buildApplyRolledBackMessage({
      filePath: "src/a.ts",
      errors: [{ code: "TS6133", message: "unused 'foo'" }],
      restoredFiles: ["src/a.ts"],
    });
    expect(msg).not.toContain("Suggested:");
  });

  it("lists multiple restored files in JSON form for multi-file rollback", () => {
    const msg = buildApplyRolledBackMessage({
      filePath: "<multiple>",
      errors: [{ code: "TS2305", message: "missing 'baz'" }],
      restoredFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    expect(msg).toContain('Files restored to pre-apply state: ["src/a.ts","src/b.ts","src/c.ts"]');
  });

  it("isApplyRolledBackMessage returns false for non-marker output", () => {
    expect(isApplyRolledBackMessage("APPLY_PATCH_OK")).toBe(false);
    expect(isApplyRolledBackMessage("")).toBe(false);
    expect(isApplyRolledBackMessage("APPLY_ROLLED_BACK no newline")).toBe(false);
  });

  it("handles zero-error case gracefully (defensive — shouldn't normally happen)", () => {
    const msg = buildApplyRolledBackMessage({
      filePath: "src/a.ts",
      errors: [],
      restoredFiles: ["src/a.ts"],
    });
    expect(msg).toContain("introduced 0 new error(s):");
    expect(msg).not.toContain("(plus");
  });
});

describe("Phase J.4 C2 — end-to-end heuristic on realistic tsc preview", () => {
  it("partial-rename dogfood scenario produces TS2305 suggestion", () => {
    // Realistic preview shape from a partial rename: one caller file
    // still imports the old name, tsc reports TS2305 + a downstream TS2304.
    const preview =
      `src/llm/agentLoop.ts(2381,7): error TS2305: Module '"./detect"' has no exported member 'detectFramework'.\n` +
      `src/llm/agentLoop.ts(2382,17): error TS2304: Cannot find name 'detectFramework'.`;
    const errors = parseTscErrorPreview(preview);
    const msg = buildApplyRolledBackMessage({
      filePath: "src/llm/agentLoop.ts",
      errors,
      restoredFiles: ["src/llm/agentLoop.ts"],
    });
    expect(applyRolledBackMessageHasSuggestion(msg)).toBe(true);
    expect(msg).toContain(ROLLED_BACK_SUGGESTIONS.get("TS2305")!);
    // The Task-tool fan-out hint must surface for the agent — this is the
    // exact phrase the system prompt teaches the agent to recognize.
    expect(msg).toContain("Task tool");
  });

  it("type-mismatch scenario (TS2339) produces the consumer-update suggestion", () => {
    const preview =
      `src/users/handlers.ts(45,12): error TS2339: Property 'role' does not exist on type 'User'.`;
    const errors = parseTscErrorPreview(preview);
    const msg = buildApplyRolledBackMessage({
      filePath: "src/users/handlers.ts",
      errors,
      restoredFiles: ["src/users/handlers.ts"],
    });
    expect(applyRolledBackMessageHasSuggestion(msg)).toBe(true);
    expect(msg).toContain("type contract changed");
  });

  it("preview with only TS6133 unused-var errors gets no suggestion", () => {
    const preview =
      `src/x.ts(10,7): error TS6133: 'unused' is declared but its value is never read.\n` +
      `src/x.ts(11,7): error TS6133: 'other' is declared but its value is never read.`;
    const errors = parseTscErrorPreview(preview);
    const msg = buildApplyRolledBackMessage({
      filePath: "src/x.ts",
      errors,
      restoredFiles: ["src/x.ts"],
    });
    expect(applyRolledBackMessageHasSuggestion(msg)).toBe(false);
    expect(msg).not.toContain("Suggested:");
  });

  it("applyRolledBackMessageHasSuggestion returns false for non-marker output", () => {
    expect(applyRolledBackMessageHasSuggestion("just a string")).toBe(false);
    expect(applyRolledBackMessageHasSuggestion("")).toBe(false);
  });
});
