import { describe, expect, it } from "vitest";
import {
  buildStrictDeveloperPatchText,
  tryRecoverDeveloperPatchFromModelOutput,
} from "./patchConversion.js";

describe("tryRecoverDeveloperPatchFromModelOutput", () => {
  it("recovers when FILE line matches and FIND/REPLACE is tolerant", () => {
    const original = `line1\nconst x = 1;\nline3`;
    const raw = [
      "--- FILE: client/src/App.jsx ---",
      "--- FIND ---",
      "const x = 1;",
      "--- REPLACE ---",
      "const x = 2;",
    ].join("\n");
    const r = tryRecoverDeveloperPatchFromModelOutput({
      requestedFilePath: "client/src/App.jsx",
      originalFileContent: original,
      rawModelText: raw,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strictPatchText).toContain("--- FILE: client/src/App.jsx ---");
      expect(r.strictPatchText).toContain("const x = 2;");
    }
  });

  it("recovers implicit single file when there is no FILE header", () => {
    const original = "alpha\nbeta\n";
    const raw = "--- FIND ---\nbeta\n--- REPLACE ---\nBETA\n";
    const r = tryRecoverDeveloperPatchFromModelOutput({
      requestedFilePath: "src/x.ts",
      originalFileContent: original,
      rawModelText: raw,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects when FIND occurs more than once", () => {
    const original = "dup\ndup\n";
    const raw = "--- FIND ---\ndup\n--- REPLACE ---\nx\n";
    const r = tryRecoverDeveloperPatchFromModelOutput({
      requestedFilePath: "f.txt",
      originalFileContent: original,
      rawModelText: raw,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects multiple FILE blocks", () => {
    const raw = [
      "--- FILE: a.ts ---",
      "--- FIND ---",
      "x",
      "--- REPLACE ---",
      "y",
      "--- FILE: b.ts ---",
      "--- FIND ---",
      "z",
      "--- REPLACE ---",
      "w",
    ].join("\n");
    const r = tryRecoverDeveloperPatchFromModelOutput({
      requestedFilePath: "a.ts",
      originalFileContent: "x",
      rawModelText: raw,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects FILE path mismatch", () => {
    const raw = [
      "--- FILE: other.ts ---",
      "--- FIND ---",
      "a",
      "--- REPLACE ---",
      "b",
    ].join("\n");
    const r = tryRecoverDeveloperPatchFromModelOutput({
      requestedFilePath: "wanted.ts",
      originalFileContent: "a",
      rawModelText: raw,
    });
    expect(r.ok).toBe(false);
  });
});

describe("buildStrictDeveloperPatchText", () => {
  it("normalizes path separators", () => {
    const s = buildStrictDeveloperPatchText("a\\b\\c.ts", "1", "2");
    expect(s).toContain("--- FILE: a/b/c.ts ---");
  });
});
