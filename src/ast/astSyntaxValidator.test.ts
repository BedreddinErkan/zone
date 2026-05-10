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
