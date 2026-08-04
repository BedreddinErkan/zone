/**
 * Phase J.4 — buildApplyRolledBackMessage shape + heuristic tests.
 */

import { describe, expect, it } from "vitest";
import {
  ROLLED_BACK_SUGGESTIONS,
  applyRolledBackMessageHasSuggestion,
  buildApplyRolledBackMarkerLog,
  buildApplyRolledBackMessage,
  isApplyRolledBackMessage,
  looksLikeTscHelpBanner,
  parseTscErrorPreview,
  parseTestFailures,
  pickRolledBackSuggestion,
  pickRolledBackSuggestionCode,
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

describe("Finding 2 — tsc help/usage banner is not a diagnostic set", () => {
  const BANNER = [
    "Version 5.9.3",
    "tsc: The TypeScript Compiler",
    "",
    "COMMON COMMANDS",
    "",
    "  tsc",
    "  Compiles the current project (tsconfig.json in the working directory.)",
    "",
    "  tsc --noEmit",
    "  ...",
    "  --help, -h",
  ].join("\n");

  it("detects the banner", () => {
    expect(looksLikeTscHelpBanner(BANNER)).toBe(true);
  });

  it("parseTscErrorPreview returns no errors for the banner", () => {
    expect(parseTscErrorPreview(BANNER)).toEqual([]);
  });

  it("does NOT treat a vitest summary or real tsc errors as a banner", () => {
    expect(looksLikeTscHelpBanner("FAIL src/x.test.ts\n  ✗ adds two numbers")).toBe(false);
    expect(
      looksLikeTscHelpBanner("src/foo.ts(12,5): error TS2305: Module has no exported member 'baz'."),
    ).toBe(false);
  });

  it("still parses real errors that happen to mention a version string", () => {
    const preview = "src/foo.ts(1,5): error TS2304: Cannot find name 'bar'.";
    const rows = parseTscErrorPreview(preview);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ code: "TS2304" });
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

  it("item 28: restoreFailed:true swaps the trailer to the could-not-restore wording", () => {
    const msg = buildApplyRolledBackMessage({
      filePath: "src/a.ts",
      errors: [{ code: "TS2305", message: "missing 'baz'" }],
      restoredFiles: [],
      restoreFailed: true,
    });
    expect(msg).toContain(
      "Disk could not be restored to the pre-apply state and may still hold the broken version. Re-read before re-attempting."
    );
    expect(msg).not.toContain("Disk is at the pre-apply state. Re-investigate before re-attempting.");
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

describe("Phase J.4.1 — parseTscErrorPreview hardening for real tsc output", () => {
  it("parses pretty-format tsc output (path:line:col - error TS####)", () => {
    // Modern tsc / npm-script wrappers often emit this even when piped.
    const preview =
      `src/llm/detectIntent.ts:42:7 - error TS2305: Module '"./detect"' has no exported member 'detectFramework'.\n` +
      `src/llm/detectIntent.ts:43:11 - error TS2304: Cannot find name 'detectFramework'.`;
    const rows = parseTscErrorPreview(preview);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      file: "src/llm/detectIntent.ts",
      line: 42,
      col: 7,
      code: "TS2305",
    });
    expect(rows[1]!.code).toBe("TS2304");
    // The heuristic must fire — this is the J.4.1 dogfood gap.
    expect(pickRolledBackSuggestion(rows)).toBe(ROLLED_BACK_SUGGESTIONS.get("TS2305")!);
  });

  it("strips ANSI color codes before parsing pretty output", () => {
    const esc = String.fromCharCode(0x1b);
    const RED = `${esc}[91m`;
    const GREY = `${esc}[90m`;
    const RESET = `${esc}[0m`;
    const preview = `${GREY}src/a.ts${RESET}:${RED}12${RESET}:${RED}5${RESET} - ${RED}error${RESET} TS2305: ${RED}missing 'baz'${RESET}`;
    const rows = parseTscErrorPreview(preview);
    expect(rows.length).toBe(1);
    expect(rows[0]!.code).toBe("TS2305");
    expect(rows[0]!.file).toBe("src/a.ts");
    expect(rows[0]!.message).toContain("missing 'baz'");
  });

  it("falls back to code-only extraction when file/line/col are unrecognized", () => {
    // Build wrapper output with no parseable location anchor.
    const preview = `ERROR in [tsc] - error TS2339: Property 'role' does not exist on type 'User'.`;
    const rows = parseTscErrorPreview(preview);
    expect(rows.length).toBe(1);
    expect(rows[0]!.code).toBe("TS2339");
    // Heuristic still fires via the code-only fallback.
    expect(pickRolledBackSuggestion(rows)).toBe(ROLLED_BACK_SUGGESTIONS.get("TS2339")!);
  });

  it("legacy format still parses (back-compat with J.4 C1 fixture)", () => {
    const preview = `src/foo.ts(12,5): error TS2305: Module '"./bar"' has no exported member 'baz'.`;
    const rows = parseTscErrorPreview(preview);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ code: "TS2305", file: "src/foo.ts", line: 12, col: 5 });
  });

  it("non-tsc verifier output (vitest summary) still goes to raw-message bucket", () => {
    const preview = `FAIL src/x.test.ts\n  ✗ adds two numbers\n  Tests: 1 failed, 3 passed`;
    const rows = parseTscErrorPreview(preview);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.code === "")).toBe(true);
  });

  it("pickRolledBackSuggestionCode returns the matched code (not just the suggestion text)", () => {
    expect(pickRolledBackSuggestionCode([{ code: "TS2305", message: "x" }])).toBe("TS2305");
    expect(pickRolledBackSuggestionCode([{ code: "TS2304", message: "x" }])).toBe("TS2304");
    expect(pickRolledBackSuggestionCode([{ code: "TS2339", message: "x" }])).toBe("TS2339");
    expect(pickRolledBackSuggestionCode([{ code: "TS6133", message: "x" }])).toBeNull();
    expect(pickRolledBackSuggestionCode([])).toBeNull();
  });
});

describe("Phase J.4.1 — buildApplyRolledBackMarkerLog payload shape", () => {
  it("returns the full diagnostic record with codes, count, and suggestion", () => {
    const errors = [
      { code: "TS2305", message: "missing 'baz'", file: "src/a.ts", line: 1, col: 1 },
      { code: "TS2304", message: "cannot find 'qux'", file: "src/a.ts", line: 2, col: 2 },
    ];
    const markerMessage = buildApplyRolledBackMessage({
      filePath: "src/a.ts",
      errors,
      restoredFiles: ["src/a.ts"],
    });
    const payload = buildApplyRolledBackMarkerLog({
      site: "natural_completion",
      markerMessage,
      errors,
      filePathsRestored: ["src/a.ts"],
      runId: "run-42",
    });
    expect(payload.site).toBe("natural_completion");
    expect(payload.markerPreview.startsWith("APPLY_ROLLED_BACK\n")).toBe(true);
    expect(payload.markerPreview.length).toBeLessThanOrEqual(200);
    expect(payload.errorCount).toBe(2);
    expect(payload.errorCodes).toEqual(["TS2305", "TS2304"]);
    expect(payload.suggestionApplied).toBe("TS2305");
    expect(payload.filePathsRestored).toEqual(["src/a.ts"]);
    expect(payload.runId).toBe("run-42");
  });

  it("suggestionApplied is null when no heuristic code is present", () => {
    const errors = [{ code: "TS6133", message: "unused 'foo'" }];
    const markerMessage = buildApplyRolledBackMessage({
      filePath: "src/a.ts",
      errors,
      restoredFiles: ["src/a.ts"],
    });
    const payload = buildApplyRolledBackMarkerLog({
      site: "max_iter",
      markerMessage,
      errors,
      filePathsRestored: ["src/a.ts"],
      runId: null,
    });
    expect(payload.suggestionApplied).toBeNull();
    expect(payload.errorCodes).toEqual(["TS6133"]);
  });

  it("errorCodes dedupes repeated codes and skips empty (non-tsc) rows", () => {
    const errors = [
      { code: "TS2305", message: "a" },
      { code: "TS2305", message: "b" },
      { code: "", message: "vitest summary line" },
      { code: "TS2304", message: "c" },
    ];
    const payload = buildApplyRolledBackMarkerLog({
      site: "inline_ts_check",
      markerMessage: "APPLY_ROLLED_BACK\n…",
      errors,
      filePathsRestored: [],
      runId: null,
    });
    expect(payload.errorCodes).toEqual(["TS2305", "TS2304"]);
    expect(payload.errorCount).toBe(4); // raw count, not dedupe
  });
});

// ── Inc B: parseTestFailures ──────────────────────────────────────────────────

describe("parseTestFailures", () => {
  it("returns [] for empty string", () => {
    expect(parseTestFailures("")).toEqual([]);
  });

  it("returns [] for unrecognized format (no FAIL/FAILED pattern)", () => {
    const output = "All tests passed.\n2 suites, 18 tests";
    expect(parseTestFailures(output)).toEqual([]);
  });

  it("returns [] for a tsc error output that has no FAIL/FAILED markers", () => {
    const output = "src/foo.ts(1,5): error TS2304: Cannot find name 'bar'.";
    expect(parseTestFailures(output)).toEqual([]);
  });

  // ── vitest default reporter (inline format) ────────────────────────────────
  it("vitest default: extracts test key from inline FAIL line (FAIL file > suite > test)", () => {
    const output = [
      "FAIL src/math.test.ts > arithmetic > adds two numbers",
      "",
      "Test Files  1 failed (1)",
    ].join("\n");
    const results = parseTestFailures(output);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      code: "TEST",
      file: "src/math.test.ts",
      message: "arithmetic > adds two numbers",
    });
  });

  it("vitest default: FAIL line without inline test path sets currentFile for following markers", () => {
    // If the FAIL line has no "> suite > test" part, it only sets currentFile.
    // In practice vitest default always has the path inline, but we must not crash.
    const output = [
      "FAIL src/math.test.ts",
      "  ✗ adds two numbers (5ms)",
    ].join("\n");
    const results = parseTestFailures(output);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      code: "TEST",
      file: "src/math.test.ts",
      message: "adds two numbers",
    });
  });

  // ── vitest verbose tree ────────────────────────────────────────────────────
  it("vitest verbose: associates ✗ markers with the preceding FAIL file", () => {
    const output = [
      "FAIL src/foo.test.ts",
      "  ✗ my test case (12ms)",
      "  ✗ another failure (3ms)",
    ].join("\n");
    const results = parseTestFailures(output);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ code: "TEST", file: "src/foo.test.ts", message: "my test case" });
    expect(results[1]).toMatchObject({ code: "TEST", file: "src/foo.test.ts", message: "another failure" });
  });

  it("vitest: handles × and ✕ failure markers as well as ✗", () => {
    const output = "FAIL src/x.test.ts\n  × test one\n  ✕ test two";
    const results = parseTestFailures(output);
    expect(results).toHaveLength(2);
    expect(results[0]!.message).toBe("test one");
    expect(results[1]!.message).toBe("test two");
  });

  // ── multi-file: no cross-contamination ────────────────────────────────────
  it("multi-file: associates each failure with its own file, not the previous", () => {
    const output = [
      "FAIL src/a.test.ts",
      "  ✗ test from A",
      "FAIL src/b.test.ts",
      "  ✗ test from B",
    ].join("\n");
    const results = parseTestFailures(output);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ file: "src/a.test.ts", message: "test from A" });
    expect(results[1]).toMatchObject({ file: "src/b.test.ts", message: "test from B" });
  });

  // ── jest bullet format ─────────────────────────────────────────────────────
  it("jest: extracts test key from ● bullet markers", () => {
    const output = [
      "FAIL src/calc.test.ts",
      "  ● Calculator › adds numbers",
    ].join("\n");
    const results = parseTestFailures(output);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      code: "TEST",
      file: "src/calc.test.ts",
      message: "Calculator › adds numbers",
    });
  });

  // ── pytest formats ─────────────────────────────────────────────────────────
  it("pytest: parses 'FAILED path::test' format", () => {
    const output = [
      "FAILED tests/test_math.py::test_addition",
      "FAILED tests/test_math.py::TestClass::test_method - AssertionError: 1 != 2",
      "short test summary info",
      "FAILED tests/test_math.py::test_addition",
    ].join("\n");
    const results = parseTestFailures(output);
    // 3 FAILED lines (dedupe is not performed by parser — caller handles that via key-set)
    expect(results.length).toBeGreaterThanOrEqual(2);
    const files = results.map((r) => r.file);
    expect(files.every((f) => f === "tests/test_math.py")).toBe(true);
    expect(results[0]).toMatchObject({ code: "TEST", message: "test_addition" });
    expect(results[1]).toMatchObject({ code: "TEST", message: "TestClass::test_method" });
  });

  it("pytest: parses 'path::test FAILED' format", () => {
    const output = "tests/test_math.py::test_subtract FAILED";
    const results = parseTestFailures(output);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      code: "TEST",
      file: "tests/test_math.py",
      message: "test_subtract",
    });
  });

  // ── normalization invariance ───────────────────────────────────────────────
  it("normalization: ANSI escape codes are stripped before parsing", () => {
    const esc = String.fromCharCode(0x1b);
    const bold = `${esc}[1m`;
    const reset = `${esc}[0m`;
    const plain = "FAIL src/foo.test.ts > suite > my test";
    const withAnsi = `${bold}FAIL${reset} src/foo.test.ts > suite > my test`;
    const plainResult = parseTestFailures(plain);
    const ansiResult = parseTestFailures(withAnsi);
    expect(plainResult).toHaveLength(1);
    expect(ansiResult).toHaveLength(1);
    // Both paths yield the same key — ANSI must not alter the message
    expect(ansiResult[0]!.message).toBe(plainResult[0]!.message);
    expect(ansiResult[0]!.file).toBe(plainResult[0]!.file);
  });

  it("normalization: trailing duration '(123ms)' is stripped from test names", () => {
    const output = "FAIL src/foo.test.ts\n  ✗ my test (123ms)";
    const results = parseTestFailures(output);
    expect(results[0]!.message).toBe("my test");
  });

  it("normalization: trailing duration '(1.2s)' is stripped from test names", () => {
    const output = "FAIL src/foo.test.ts\n  ✗ slow test (1.2s)";
    const results = parseTestFailures(output);
    expect(results[0]!.message).toBe("slow test");
  });

  it("normalization: internal whitespace is collapsed to single spaces", () => {
    const output = "FAIL src/foo.test.ts\n  ✗ my   test  name";
    const results = parseTestFailures(output);
    expect(results[0]!.message).toBe("my test name");
  });

  it("normalization: same test with/without timing yields identical key", () => {
    const withTiming = parseTestFailures("FAIL src/x.test.ts\n  ✗ parses input (47ms)");
    const withoutTiming = parseTestFailures("FAIL src/x.test.ts\n  ✗ parses input");
    expect(withTiming[0]!.message).toBe(withoutTiming[0]!.message);
  });

  // ── repoPath relativization ────────────────────────────────────────────────
  it("repoPath: absolute path in output is made repo-relative", () => {
    const output = "FAIL /repo/src/foo.test.ts\n  ✗ my test";
    const results = parseTestFailures(output, "/repo");
    expect(results[0]!.file).toBe("src/foo.test.ts");
  });

  it("repoPath: already-relative path is left unchanged", () => {
    const output = "FAIL src/foo.test.ts\n  ✗ my test";
    const results = parseTestFailures(output, "/repo");
    expect(results[0]!.file).toBe("src/foo.test.ts");
  });

  it("repoPath: path outside repo is kept absolute rather than producing '../..' prefix", () => {
    const output = "FAIL /other/foo.test.ts\n  ✗ my test";
    const results = parseTestFailures(output, "/repo");
    // normTestPath must not produce a path starting with ".."
    expect(results[0]!.file).not.toMatch(/^\.\.\//);
  });
});
