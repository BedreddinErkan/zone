import { describe, expect, it } from "vitest";
import {
  validatePatchCorrectness,
  type PatchCorrectnessInput,
} from "../patchCorrectnessValidator.js";

function buildInput(
  overrides: Partial<PatchCorrectnessInput> = {}
): PatchCorrectnessInput {
  return {
    filePath: "src/example.ts",
    originalContent: "export const x = 1;\n",
    updatedContent: "export const x = 2;\n",
    task: "Change x",
    isConstrained: false,
    taskConstraints: {
      requiresExistingForm: false,
      requiresExistingSubmitFlow: false,
      requiresExistingState: false,
      avoidsNewForm: false,
      avoidsNewApiCall: false,
    },
    strictMode: false,
    ...overrides,
  };
}

describe("validatePatchCorrectness", () => {
  it("valid JS with normal if blocks passes layer 1", () => {
    const src = [
      "export function f(x: number) {",
      "  if (x > 1) {",
      "    return { ok: true, value: [1, 2, 3] };",
      "  }",
      "  return { ok: false };",
      "}",
      "",
    ].join("\n");
    const result = validatePatchCorrectness(buildInput({ updatedContent: src }));
    expect(result.ok).toBe(true);
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      false
    );
  });

  it("valid JSX file passes layer 1", () => {
    const src = [
      "export function A() {",
      "  return (",
      "    <div>",
      "      <span>{\")\"}</span>",
      "    </div>",
      "  );",
      "}",
      "",
    ].join("\n");
    const result = validatePatchCorrectness(
      buildInput({ filePath: "src/A.jsx", updatedContent: src })
    );
    expect(result.ok).toBe(true);
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      false
    );
  });

  it("valid template literal text containing delimiters passes", () => {
    const src = "export const s = `text has { } ( ) [ ]`; \n";
    const result = validatePatchCorrectness(buildInput({ updatedContent: src }));
    expect(result.ok).toBe(true);
  });

  it("no-op: identical before/after blocks with no_op_patch", () => {
    // no_op_patch now fires only when rawDiffCounts.addedLines===0 AND removedLines===0.
    // Removing a comment changes a line (1 removed, 1 added) → no longer treated as no-op.
    const result = validatePatchCorrectness(
      buildInput({
        originalContent: "export const x = 1; // comment\n",
        updatedContent: "export const x = 1;\n",
      })
    );
    expect(result.ok).toBe(true);
    expect(result.blocking.some((i) => i.code === "no_op_patch")).toBe(false);
  });

  it("broken setter: setSuccess(\"\" if (...) blocks", () => {
    const src = `export function A() {
  setSuccess("" if (!fullName) return;
}`;
    const result = validatePatchCorrectness(buildInput({ updatedContent: src }));
    expect(result.ok).toBe(false);
    expect(
      result.blocking.some((i) =>
        ["inline_keyword_in_call", "broken_setter_call", "unbalanced_delimiters"].includes(
          i.code
        )
      )
    ).toBe(true);
  });

  it("unbalanced braces blocks with unbalanced_delimiters", () => {
    const result = validatePatchCorrectness(
      buildInput({
        updatedContent: "export function foo() { return 1;\n",
      })
    );
    expect(result.ok).toBe(false);
    expect(
      result.blocking.some((i) => i.code === "unbalanced_delimiters")
    ).toBe(true);
  });

  it("does not block unbalanced_delimiters when BEFORE was already unbalanced and counts are unchanged (minimal patch)", () => {
    const before =
      "export function foo() {\n" +
      "  d\n" +
      "  return 1;\n"; // missing closing }
    const after =
      "export function foo() {\n" +
      "  return 1;\n"; // still missing closing }, same delimiter counts (removed one non-delimiter line)
    const result = validatePatchCorrectness(
      buildInput({
        originalContent: before,
        updatedContent: after,
        filePath: "client/src/pages/app/PatientScanViewerPage.jsx",
        isConstrained: true,
      })
    );
    expect(result.ok).toBe(true);
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      false
    );
  });

  it("blocks unbalanced_delimiters when patch worsens delimiter counts", () => {
    const before = "export function foo() { return 1;\n"; // missing }
    const after = "export function foo() { if (x) { return 1;\n"; // adds another '{' (worse)
    const result = validatePatchCorrectness(
      buildInput({
        originalContent: before,
        updatedContent: after,
        filePath: "client/src/pages/app/PatientScanViewerPage.jsx",
        isConstrained: true,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      true
    );
  });

  it("template-literal expression bug regression: `${foo(}` blocks", () => {
    const src = "export const x = `${foo(}`;\n";
    const result = validatePatchCorrectness(buildInput({ updatedContent: src }));
    expect(result.ok).toBe(false);
    expect(
      result.blocking.some((i) =>
        ["broken_template_expression", "unbalanced_delimiters"].includes(i.code)
      )
    ).toBe(true);
  });

  it("valid template literal passes", () => {
    const src = "export const x = `hello ${name.toUpperCase()}!`;\n";
    const result = validatePatchCorrectness(buildInput({ updatedContent: src }));
    expect(result.ok).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("valid template literal expression with nested delimiters passes", () => {
    const src =
      "const x = `${items.map((item) => ({ id: item.id }))}`;\nexport const y = x;\n";
    const result = validatePatchCorrectness(buildInput({ updatedContent: src }));
    expect(result.ok).toBe(true);
  });

  it("dropped export on constrained task blocks", () => {
    const before = "export function PatientsPage() { return null; }\n";
    const after = "function PatientsPage() { return null; }\n";
    const result = validatePatchCorrectness(
      buildInput({
        filePath: "client/src/pages/PatientsPage.jsx",
        originalContent: before,
        updatedContent: after,
        isConstrained: true,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.blocking.some((i) => i.code === "dropped_export")).toBe(true);
  });

  it("dropped export on non-constrained task warns but does not block", () => {
    const before = "export function PatientsPage() { return null; }\n";
    const after = "function PatientsPage() { return null; }\n";
    const result = validatePatchCorrectness(
      buildInput({
        filePath: "client/src/pages/PatientsPage.jsx",
        originalContent: before,
        updatedContent: after,
        isConstrained: false,
      })
    );
    expect(result.ok).toBe(true);
    expect(result.blocking).toEqual([]);
    expect(result.warnings.some((i) => i.code === "dropped_export")).toBe(true);
  });

  it("constrained too-large blocks with constrained_patch_too_large", () => {
    const before = "export const x = 1;\n";
    const after =
      before +
      Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join(
        "\n"
      ) +
      "\n";
    const result = validatePatchCorrectness(
      buildInput({
        originalContent: before,
        updatedContent: after,
        isConstrained: true,
      })
    );
    expect(result.ok).toBe(false);
    expect(
      result.blocking.some((i) =>
        ["constrained_patch_too_large", "byte_explosion"].includes(i.code)
      )
    ).toBe(true);
  });

  it("broken import blocks with broken_import_line", () => {
    const src = 'import { useState from "react";\nexport const x = 1;\n';
    const result = validatePatchCorrectness(
      buildInput({ filePath: "src/example.ts", updatedContent: src })
    );
    expect(result.ok).toBe(false);
    expect(
      result.blocking.some((i) =>
        ["broken_import_line", "unbalanced_delimiters"].includes(i.code)
      )
    ).toBe(true);
  });

  it("does not block broken_import_line when patch does not touch the import region and is minimal", () => {
    const before =
      'import { useState from "react";\n' + // broken import line (missing })
      "export const x = 1;\n" +
      "\n" +
      "const stray = 'd';\n";
    const after =
      'import { useState from "react";\n' +
      "export const x = 1;\n" +
      "\n";
    const result = validatePatchCorrectness(
      buildInput({
        filePath: "client/src/pages/app/PatientScanViewerPage.jsx",
        originalContent: before,
        updatedContent: after,
        isConstrained: true,
      })
    );
    expect(result.ok).toBe(true);
    expect(result.blocking.some((i) => i.code === "broken_import_line")).toBe(false);
  });

  it("strictMode promotes warn to block", () => {
    const before = "export function PatientsPage() { return null; }\n";
    const after = "function PatientsPage() { return null; }\n";
    const result = validatePatchCorrectness(
      buildInput({
        originalContent: before,
        updatedContent: after,
        isConstrained: false,
        strictMode: true,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.blocking.some((i) => i.code === "dropped_export")).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("CSS file skips layer 2 heuristics (no false positive)", () => {
    const css = "body { color: red; }\n";
    const result = validatePatchCorrectness(
      buildInput({
        filePath: "styles/app.css",
        originalContent: "body { color: blue; }\n",
        updatedContent: css,
      })
    );
    expect(result.ok).toBe(true);
  });

  it("JSX tag imbalance emits warn, not block", () => {
    const before = `export function A(){ return <div></div>; }\n`;
    const after = `export function A(){ return <div><span></div>; }\n`;
    const result = validatePatchCorrectness(
      buildInput({
        filePath: "src/A.jsx",
        originalContent: before,
        updatedContent: after,
      })
    );
    expect(result.blocking.some((i) => i.code === "jsx_tag_imbalance")).toBe(
      false
    );
    expect(result.warnings.some((i) => i.code === "jsx_tag_imbalance")).toBe(
      true
    );
  });

  it("PatientsPage-style fallback insert is not blocked by layer 1 when balanced", () => {
    const before = [
      "export function PatientsPage() {",
      "  const handleSubmit = async (e) => {",
      "    e.preventDefault();",
      "    setFormError(\"\");",
      "    setSuccess(\"\");",
      "    await createPatient({ fullName, email });",
      "  };",
      "  return <form onSubmit={handleSubmit}></form>;",
      "}",
      "",
    ].join("\n");
    const validation = [
      "    if (!fullName || fullName.trim() === \"\") {",
      "      setError(\"Full name is required\");",
      "      return;",
      "    }",
      "",
      "    if (email && !email.includes(\"@\")) {",
      "      setError(\"Invalid email\");",
      "      return;",
      "    }",
    ].join("\n");
    const insertAt = before.indexOf('setSuccess(\"\");') + 'setSuccess(\"\");'.length;
    const after =
      before.slice(0, insertAt) + "\n" + validation + "\n" + before.slice(insertAt);
    const result = validatePatchCorrectness(
      buildInput({
        filePath: "client/src/pages/PatientsPage.jsx",
        originalContent: before,
        updatedContent: after,
      })
    );
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      false
    );
  });

  it("valid JSX map option pattern does not false-positive in layer 1", () => {
    const src = [
      "export function Select({ items }) {",
      "  return (",
      "    <select>",
      "      {items.map((s) => (",
      "        <option key={s.id}>{s.label}</option>",
      "      ))}",
      "    </select>",
      "  );",
      "}",
      "",
    ].join("\n");
    const result = validatePatchCorrectness(
      buildInput({ filePath: "src/Select.jsx", updatedContent: src })
    );
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      false
    );
  });

  it("valid IIFE JSX pattern does not false-positive in layer 1", () => {
    const src = [
      "export function Wrap() {",
      "  return (",
      "    <div>",
      "      {(() => { return <div></div>; })()}",
      "    </div>",
      "  );",
      "}",
      "",
    ].join("\n");
    const result = validatePatchCorrectness(
      buildInput({ filePath: "src/Wrap.jsx", updatedContent: src })
    );
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      false
    );
  });

  it("valid select/map/option JSX pattern passes (prod regression shape)", () => {
    const src = `
export default function PatientsPage() {
  const statuses = [{ value: "active", label: "Active" }];
  return (
    <select>
      {statuses.map((s) => (
        <option key={s.value} value={s.value}>{s.label}</option>
      ))}
    </select>
  );
}
`;
    const result = validatePatchCorrectness(
      buildInput({ filePath: "client/src/pages/PatientsPage.jsx", updatedContent: src })
    );
    expect(result.ok).toBe(true);
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      false
    );
  });

  it("valid multiline option with nested JSX expression passes", () => {
    const src = `
export default function PatientsPage() {
  const statuses = [{ value: "active", label: "Active" }];
  return (
    <select>
      {statuses.map((s) => (
        <option
          key={s.value}
          value={s.value}
        >
          {s.label}
        </option>
      ))}
    </select>
  );
}
`;
    const result = validatePatchCorrectness(
      buildInput({ filePath: "client/src/pages/PatientsPage.jsx", updatedContent: src })
    );
    expect(result.ok).toBe(true);
  });

  it("invalid select/map/option pattern missing a closing paren is blocked", () => {
    const src = `
export default function PatientsPage() {
  const statuses = [{ value: "active", label: "Active" }];
  return (
    <select>
      {statuses.map((s) => (
        <option key={s.value} value={s.value}>{s.label}</option>
      ))}
    </select>
  );
}
`; // remove one ) from the end sequence
    const broken = src.replace("      ))}", "      )}");
    const result = validatePatchCorrectness(
      buildInput({ filePath: "client/src/pages/PatientsPage.jsx", updatedContent: broken })
    );
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      true
    );
  });

  it("invalid JSX map option pattern missing closing paren is blocked", () => {
    const src = [
      "export function Select({ items }) {",
      "  return (",
      "    <select>",
      "      {items.map((s) => (",
      "        <option key={s.id}>{s.label}</option>",
      "      )}",
      "    </select>",
      "  );",
      "}",
      "",
    ].join("\n");
    const result = validatePatchCorrectness(
      buildInput({ filePath: "src/Select.jsx", updatedContent: src })
    );
    expect(result.blocking.some((i) => i.code === "unbalanced_delimiters")).toBe(
      true
    );
  });
});

