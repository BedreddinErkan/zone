import { describe, expect, it } from "vitest";
import { __testOnly_applyDeveloperPatchText } from "../runLlmPatchFlow.js";

function wrapPatch(find: string, replace: string): string {
  return [
    "--- FILE: client/src/pages/app/PatientScanViewerPage.jsx ---",
    "--- FIND ---",
    find,
    "--- REPLACE ---",
    replace,
  ].join("\n");
}

describe("applyDeveloperPatchText localized replacement", () => {
  it("CRLF file: removes one stray line and preserves CRLF outside replacement", () => {
    const content =
      "line1\r\n" +
      "      d\r\n" +
      "              </div>\r\n" +
      "line4\r\n";
    const patch = wrapPatch("      d\r\n              </div>", "              </div>");
    const applied = __testOnly_applyDeveloperPatchText(content, patch);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.fullContent).toContain("\r\n");
      // No lone LF introduced.
      expect(/(^|[^\r])\n/.test(applied.fullContent)).toBe(false);
      expect(applied.fullContent).not.toContain("      d\r\n");
      expect(applied.fullContent).not.toContain("--- FIND ---");
      expect(applied.fullContent).not.toContain("--- REPLACE ---");
    }
  });

  it("exact match applies without normalizing unrelated lines", () => {
    const content = "A\r\nB\r\nC\r\n";
    const patch = wrapPatch("B", "B2");
    const applied = __testOnly_applyDeveloperPatchText(content, patch);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.fullContent).toBe("A\r\nB2\r\nC\r\n");
    }
  });

  it("ambiguous repeated FIND fails safely", () => {
    const content = "dup\nx\ndup\n";
    const patch = wrapPatch("dup", "z");
    const applied = __testOnly_applyDeveloperPatchText(content, patch);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.warning).toContain("[PATCH_FIND_NOT_FOUND]");
      expect(applied.warning).toContain("ambiguous_match");
    }
  });

  it("missing FIND fails safely", () => {
    const content = "only\nonce\n";
    const patch = wrapPatch("not-there", "x");
    const applied = __testOnly_applyDeveloperPatchText(content, patch);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      // fuzzyFindAndReplace is attempted first; on total miss it returns PATCH_FIND_NOT_FOUND
      expect(applied.warning).toContain("[PATCH_FIND_NOT_FOUND]");
    }
  });

  it("blocks protocol marker leakage in replacement output", () => {
    const content = "A\nB\nC\n";
    const patch = wrapPatch("B", "B\n--- FIND ---\nX");
    const applied = __testOnly_applyDeveloperPatchText(content, patch);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.warning).toContain("[PATCH_PROTOCOL_LEAK]");
      expect(applied.warning).toContain("patch_protocol_leak");
    }
  });

  it("instruction-like FIND block is rejected (patch_protocol_leak)", () => {
    const content = "function foo(){\n  return 1;\n}\n";
    const find =
      "// Guard: Ensure selectedUpload...\n" +
      "// Usage example...\n" +
      "// Example:\n";
    const patch = wrapPatch(find, "x");
    const applied = __testOnly_applyDeveloperPatchText(content, patch);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.warning).toContain("[PATCH_PROTOCOL_LEAK]");
      expect(applied.warning).toContain("syntheticFindBlock");
      expect(applied.warning).toContain("patch_protocol_leak");
    }
  });

  it("rejects tiny FIND anchor (≤2 non-empty lines) with large REPLACE (>20 lines)", () => {
    const content = "// UTIL: simple email format check\nfunction f() {}\n";
    const find = "// UTIL: simple email format check";
    const replace = Array.from({ length: 21 }, (_, i) => `  line${i + 1}();`).join("\n");
    const patch = wrapPatch(find, replace);
    const applied = __testOnly_applyDeveloperPatchText(content, patch, {
      filePath: "src/example.ts",
    });
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.warning).toContain("[ANCHOR_TOO_SMALL_FOR_LARGE_REPLACE]");
      expect(applied.warning).toContain("anchor_too_small_for_large_replace");
    }
  });

  it("allows FIND with 3+ non-empty lines alongside large REPLACE", () => {
    const find = "ONE\nTWO\nTHREE";
    const content = `${find}\nREST\n`;
    const replace = `${find}\n` + Array.from({ length: 21 }, (_, i) => `x${i}`).join("\n");
    const patch = wrapPatch(find, replace);
    const applied = __testOnly_applyDeveloperPatchText(content, patch);
    expect(applied.ok).toBe(true);
  });

  it.skip("raw match count 0 is blocked unless LF-normalized match is exactly 1", () => {
    // fuzzyFindAndReplace now accepts whitespace-normalised matches (normalizeLineForMatch);
    // the raw-match-0 guard only blocks when fuzzy also fails or produces zero changed lines.
    // Original assertion (PATCH_PROTOCOL_LEAK + rawMatchCount) no longer applies — removed 2026-05-22.
  });
});

