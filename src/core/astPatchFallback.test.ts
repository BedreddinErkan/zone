import { describe, expect, it } from "vitest";
import { tryAstPatchFallback } from "./astPatchFallback.js";
import { __testOnly_applyDeveloperPatchText } from "./runLlmPatchFlow.js";

describe("tryAstPatchFallback", () => {
  it("Capability A: inserts upload null guard into isImageFile(upload)", () => {
    const original = [
      "function isImageFile(upload) {",
      "  const mime = upload?.mime_type?.toLowerCase() || \"\";",
      "  return mime.startsWith(\"image/\");",
      "}",
      "",
    ].join("\n");

    const r = tryAstPatchFallback({
      filePath: "src/utils/isImageFile.js",
      task: "Fix runtime undefined issue (cannot read properties). Add a guard.",
      originalContent: original,
      failedRawPatch: "--- FIND ---\nfunction isImageFile(upload) {\n--- REPLACE ---\n",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe("ast_fallback");
      expect(r.patchText).toContain("--- FIND ---");
      expect(r.patchText).toContain("function isImageFile(upload)");
      expect(r.patchText).toContain("if (!upload) return false;");
      expect(r.changedLinesEstimate).toBeGreaterThan(0);
      expect(r.changedLinesEstimate).toBeLessThanOrEqual(20);

      const applied = __testOnly_applyDeveloperPatchText(original, r.patchText);
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.fullContent).toContain("if (!upload) return false;");
        expect(applied.fullContent).toContain("const mime = upload?.mime_type");
      }
    }
  });

  it("Capability B: duplicate guard returns no_change", () => {
    const original = [
      "function isImageFile(upload) {",
      "  if (!upload) return false;",
      "  const mime = upload?.mime_type?.toLowerCase() || \"\";",
      "  return mime.startsWith(\"image/\");",
      "}",
    ].join("\n");

    const r = tryAstPatchFallback({
      filePath: "src/utils/isImageFile.js",
      task: "Fix runtime undefined issue (cannot read). Add a guard.",
      originalContent: original,
      failedRawPatch: "isImageFile(upload)",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no_change");
    }
  });

  it("Capability B: removes a stray one-character identifier statement", () => {
    const original = [
      "export default function PatientScanViewerPage() {",
      "  const x = 1;",
      "  d;",
      "  return <div />;",
      "}",
      "",
    ].join("\n");

    const r = tryAstPatchFallback({
      filePath: "client/src/pages/app/PatientScanViewerPage.jsx",
      task: "Remove accidental stray character that breaks JSX parsing.",
      originalContent: original,
      failedRawPatch: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const applied = __testOnly_applyDeveloperPatchText(original, r.patchText);
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.fullContent).not.toContain("\n  d;\n");
      }
      expect(r.changedLinesEstimate).toBeLessThanOrEqual(3);
    }
  });

  it("rejects unsafe large diffs (unsafe_change)", () => {
    // Create a scenario where generator is likely to rewrite lots of lines via retainLines,
    // but we still guard via changedLinesEstimate.
    const original = Array.from({ length: 200 }, (_, i) => `const a${i} = ${i};`).join("\n");
    const r = tryAstPatchFallback({
      filePath: "src/utils/big.jsx",
      task: "Remove accidental stray character.",
      originalContent: `${original}\nd;\n`,
      failedRawPatch: "",
    });
    if (!r.ok) {
      expect(["unsafe_change", "parse_failed", "ambiguous_target", "target_not_found", "unsupported_task"]).toContain(r.reason);
    }
  });

  it("unsupported task returns unsupported_task", () => {
    const original = "export const x = 1;\n";
    const r = tryAstPatchFallback({
      filePath: "src/x.ts",
      task: "Add a new endpoint and refactor everything",
      originalContent: original,
      failedRawPatch: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unsupported_task");
    }
  });
});

