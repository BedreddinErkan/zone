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
      expect(applied.warning).toContain("[PATCH_NO_MATCH_ABORT]");
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
});

