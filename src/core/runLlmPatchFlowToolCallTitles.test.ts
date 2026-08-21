import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Structural guard: every `onToolCall` handler in `runLlmPatchFlow.ts` builds its transcript title
 * through the shared argument mapping, rather than hand-rolling a second one.
 *
 * WHY IT EXISTS. Two of the three handlers in this file previously wrote
 * `args.filePath || args.command` inline, covering **two** of the seventeen cases
 * `toolCallIdentifyingArg` knows — so a `list_files` call during an autofix rendered as
 * `[fix] list_files: ` with an empty tail. Nothing objected, because the sites sit ~6,900 lines deep
 * inside one function where an inline arrow is not reachable from a test. The behavioural half now
 * lives in `toolCallIdentifyingArg.test.ts` against the extracted `fixLoopToolCallTitle`; this half
 * pins that the call sites keep going through it.
 *
 * WHY IT IS FILE-SCOPED, AND WHY THAT IS A JUDGEMENT RATHER THAN AN ASSERTION. `planInvestigation.ts`
 * and `investigationFlow.ts` also define `onToolCall` handlers with their own extraction, and they are
 * deliberately excluded: both additionally accumulate context files, and they display *different*
 * required arguments of `find_references` (`sourceFile` versus `symbolName`, both required by the tool's
 * own schema), so each is a valid display choice rather than a defect. A guard covering them would be
 * asserting something untrue.
 *
 * The contrast worth keeping: a path-existence guard over `CLAUDE.md` was declined last pass because it
 * needed an exception list that grows silently as the file legitimately references more removed things.
 * This guard needs **no exception list at all** — every handler in its scope routes through the helper —
 * which is what makes "reachable here" a measured difference rather than a preference.
 */

const FLOW_PATH = path.resolve(import.meta.dirname, "runLlmPatchFlow.ts");
const HELPER_PATH = path.resolve(import.meta.dirname, "toolCallIdentifyingArg.ts");

/** `propertyName` is a parameter so the guard's own matcher can be pointed at something unmatchable. */
function onToolCallHandlers(
  sourceText: string,
  propertyName = "onToolCall",
): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile("f.ts", sourceText, ts.ScriptTarget.Latest, true);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === propertyName &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      out.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: node.initializer.getText(),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const ROUTERS = ["toolCallIdentifyingArg", "fixLoopToolCallTitle"] as const;

describe("every onToolCall handler in runLlmPatchFlow routes titles through the shared mapping", () => {
  const source = fs.readFileSync(FLOW_PATH, "utf8");
  const handlers = onToolCallHandlers(source);

  it("finds all three handlers — not vacuous", () => {
    expect(handlers).toHaveLength(3);
  });

  it("every handler references one of the shared routers", () => {
    const stray = handlers
      .filter((h) => !ROUTERS.some((r) => h.text.includes(r)))
      .map((h) => `line ${h.line}`);
    expect(stray).toEqual([]);
  });

  it("no handler hand-rolls the old two-argument expression", () => {
    const handRolled = handlers
      .filter((h) => /args\s*(as any)?\s*\)?\??\.\s*filePath\s*\|\|/.test(h.text))
      .map((h) => `line ${h.line}`);
    expect(handRolled).toEqual([]);
  });

  /** Transitivity: the wrapper is only worth routing to if it itself defers to the mapping. */
  it("fixLoopToolCallTitle delegates to toolCallIdentifyingArg", () => {
    const helper = fs.readFileSync(HELPER_PATH, "utf8");
    const body = /export function fixLoopToolCallTitle[\s\S]*?\n}/.exec(helper)?.[0] ?? "";
    expect(body).not.toBe("");
    expect(body).toContain("toolCallIdentifyingArg(name, args)");
  });

  // ── detector mutations: aimed at what the guard DETECTS WITH ────────────────────────────────
  // A set check over three handlers passes just as happily at zero-equals-zero.

  it("detector: a property name that cannot match finds no handlers, proving the name is load-bearing", () => {
    expect(onToolCallHandlers(source, "onToolCallXX")).toEqual([]);
  });

  it("detector: a hand-rolled handler in the scanned text IS reported, so the pass above is not vacuous", () => {
    const mutated = source.replace(
      "title: fixLoopToolCallTitle(name, args),",
      'title: `[fix] ${name}: ${String((args as any)?.filePath || (args as any)?.command || "")}`,',
    );
    expect(mutated).not.toBe(source);
    const mutatedHandlers = onToolCallHandlers(mutated);
    expect(mutatedHandlers).toHaveLength(3);
    const stray = mutatedHandlers.filter((h) => !ROUTERS.some((r) => h.text.includes(r)));
    expect(stray.length).toBeGreaterThan(0);
  });
});
