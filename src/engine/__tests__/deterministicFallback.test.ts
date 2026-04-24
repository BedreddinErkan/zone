import { describe, expect, it } from "vitest";

// We keep this test co-located under engine tests, but the deterministic fallback
// builder currently lives in runLlmPatchFlow. Importing it directly keeps this
// regression focused on the CRLF/LF offset arithmetic.
import { __testOnly_buildDeterministicFallbackPatch } from "../../core/runLlmPatchFlow.js";

describe("buildDeterministicFallbackPatch line endings", () => {
  const CRLF_FILE = [
    'import { useState } from "react";',
    "",
    "export default function PatientsPage() {",
    '  const [fullName, setFullName] = useState("");',
    '  const [email, setEmail] = useState("");',
    '  const [error, setError] = useState("");',
    '  const [success, setSuccess] = useState("");',
    "",
    "  const handleSubmit = async (e) => {",
    "    e.preventDefault();",
    '    setFormError("");',
    '    setSuccess("");',
    "    await createPatient({ fullName, email });",
    "  };",
    "",
    "  return <form onSubmit={handleSubmit}></form>;",
    "}",
    "",
  ].join("\r\n");

  const LF_FILE = CRLF_FILE.replace(/\r\n/g, "\n");

  it("insert point falls on a line boundary for CRLF input (normalized space)", () => {
    const fallback = __testOnly_buildDeterministicFallbackPatch({
      filePath: "PatientsPage.jsx",
      fileContent: CRLF_FILE,
    });
    expect(fallback).not.toBeNull();
    const normalized = CRLF_FILE.replace(/\r\n/g, "\n");
    const charBefore =
      fallback!.insertIndex > 0 ? normalized[fallback!.insertIndex - 1] : undefined;
    const charAt = normalized[fallback!.insertIndex];
    expect(charBefore === "\n" || fallback!.insertIndex === 0).toBe(true);
    expect(charAt === undefined || charAt !== '"').toBe(true);
  });

  it("CRLF and LF inputs produce identical insert positions in normalized space", () => {
    const crlfResult = __testOnly_buildDeterministicFallbackPatch({
      filePath: "PatientsPage.jsx",
      fileContent: CRLF_FILE,
    });
    const lfResult = __testOnly_buildDeterministicFallbackPatch({
      filePath: "PatientsPage.jsx",
      fileContent: LF_FILE,
    });
    expect(crlfResult?.insertIndex).toBe(lfResult?.insertIndex);
  });

  it("CRLF full-pipeline fallback produces balanced delimiters and does not split setters", () => {
    const hasCrlf = true;
    const normalized = CRLF_FILE.replace(/\r\n/g, "\n");
    const f = __testOnly_buildDeterministicFallbackPatch({
      filePath: "PatientsPage.jsx",
      fileContent: normalized,
    })!;
    const updatedNormalized =
      normalized.slice(0, f.insertIndex) +
      `\n${f.validationBlock}\n` +
      normalized.slice(f.insertIndex);
    const updated = hasCrlf ? updatedNormalized.replace(/\n/g, "\r\n") : updatedNormalized;

    const count = (s: string, c: string) => s.split(c).length - 1;
    expect(count(updated, "(") - count(updated, ")")).toBe(0);
    expect(count(updated, "{") - count(updated, "}")).toBe(0);
    expect(count(updated, "[") - count(updated, "]")).toBe(0);

    expect(updated).not.toMatch(/setSuccess\(\s*""[^)]*$/m);
    expect(updated).not.toMatch(/setError\(\s*""[^)]*$/m);
    expect(updated).not.toMatch(/setFormError\(\s*""[^)]*$/m);
  });
});

