import { describe, expect, it } from "vitest";
import {
  checkSemanticSmells,
  validateSyntax,
} from "./astSyntaxValidator.js";
import { detectRepeatedFailure, type FailureRecord } from "../llm/agentLoop.js";

function checkedSmells(after: string, before?: string) {
  const syntax = validateSyntax(after, "example.ts");
  expect(syntax.ok).toBe(true);
  return checkSemanticSmells(after, "example.ts", syntax.ast, before);
}

describe("checkSemanticSmells template expression tolerance", () => {
  it("does not flag a pre-existing broken template literal in an unchanged region", () => {
    const before = [
      "const header = 'before';",
      "const warning = `Do not write $ {expr}; use ${expr}`;",
      "const footer = 'after';",
    ].join("\n");
    const after = [
      "/** Added documentation. */",
      "const header = 'before';",
      "const warning = `Do not write $ {expr}; use ${expr}`;",
      "const footer = 'after';",
    ].join("\n");

    expect(checkedSmells(after, before)).toEqual({ ok: true });
  });

  it("does not flag when the pre-existing broken template literal is removed", () => {
    const before = [
      "const warning = `Do not write $ {expr}; use ${expr}`;",
      "const footer = 'after';",
    ].join("\n");
    const after = [
      "const warning = `Use ${expr}`;",
      "const footer = 'after';",
    ].join("\n");

    expect(checkedSmells(after, before)).toEqual({ ok: true });
  });

  it("still flags a broken template literal introduced by the agent", () => {
    const before = "const warning = `Use ${expr}`;";
    const after = "const warning = `Do not write $ {expr}; use ${expr}`;";

    expect(checkedSmells(after, before)).toMatchObject({
      ok: false,
      reason: "broken_template_expression",
    });
  });

  it("keeps full-content checking for new files with no before content", () => {
    const after = "const warning = `Do not write $ {expr}; use ${expr}`;";

    expect(checkedSmells(after)).toMatchObject({
      ok: false,
      reason: "broken_template_expression",
    });
  });
});

describe("duplicate_import_statement baseline-diff suppression", () => {
  it("T.1 detects duplicate import in post-apply content alone (no baseline match → no suppression)", () => {
    // before: single import from 'x'; after: agent added a second import from same module
    const before = "import a from 'x';";
    const after = "import a from 'x';\nimport { helper } from 'x';";
    const result = checkedSmells(after, before);
    expect(result).toMatchObject({
      ok: false,
      reason: "duplicate_import_statement",
      baselineDetected: false,
    });
    expect(result.baselineCategory).toBeUndefined();
  });

  it("T.2 suppresses when duplicate import was pre-existing in before content", () => {
    // both before and after have duplicate imports from 'x'; agent only added a function
    const before = "import a from 'x';\nimport b from 'x';";
    const after = "import a from 'x';\nimport b from 'x';\nfunction newRoute() {}";
    const result = checkedSmells(after, before);
    expect(result).toMatchObject({
      ok: false,
      reason: "duplicate_import_statement",
      baselineDetected: true,
      baselineCategory: "duplicate_import_statement",
    });
  });

  it("T.3 no suppression when duplicate_import category differs from duplicate_function_def", () => {
    // before has duplicate_import_statement; after introduces both duplicate import AND duplicate adjacent JSDoc
    // This test verifies that category matching is required; function_def is not a real smell category
    // so we use a scenario where before has the dup import but after introduces a *new* dup import
    // from a *different* module (no baseline match for that module → no suppression).
    const before = "import a from 'x';\nimport b from 'x';"; // dup from 'x'
    const after = "import a from 'y';\nimport b from 'y';"; // dup from 'y' — different module
    const result = checkedSmells(after, before);
    expect(result).toMatchObject({
      ok: false,
      reason: "duplicate_import_statement",
      baselineDetected: false, // 'y' was not duplicated in before
    });
  });

  it("T.4 backward compat: no priorContent → behaves exactly as before (no new fields on clean file)", () => {
    const after = "import a from 'x';\nconst b = 1;";
    const result = checkedSmells(after);
    expect(result).toEqual({ ok: true });
  });
});

describe("apply_patch semantic smell failure repetition", () => {
  it("detects two consecutive concrete smell triggers on the same file", () => {
    const history = new Map<string, FailureRecord[]>();
    history.set("src/llm/agentLoop.ts", [
      {
        trigger: "broken_template_expression",
        errorLine: null,
        patchHash: "patch-a",
        iter: 1,
      },
      {
        trigger: "broken_template_expression",
        errorLine: null,
        patchHash: "patch-b",
        iter: 2,
      },
    ]);

    expect(detectRepeatedFailure(history, "src/llm/agentLoop.ts")).toEqual({
      filePath: "src/llm/agentLoop.ts",
      reason: "same_trigger_repeated_2x",
    });
  });
});
