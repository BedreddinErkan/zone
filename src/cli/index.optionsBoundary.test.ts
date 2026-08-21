import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { Command } from "commander";
import { buildCliFlags, parseMaxTurns, parseMaxBudgetUsd } from "./index.js";
import { buildRealCommand, extractDeclaredOptionStrings } from "./cliOptionsIntrospection.js";

/**
 * The regression test for ledger item 258, and the reason it exists rather than extending
 * `config.test.ts`: those tests call `loadCliConfig({ noRevision: true })` /
 * `({ noColor: true })` with a hand-built object, bypassing commander entirely — they assert the
 * downstream plumbing works given the right input and cannot fail on the actual defect, which was
 * that the input never arrived. This file builds a real `commander.Command` from `index.ts`'s own
 * declared options, parses a real argv, and only then calls `buildCliFlags` — the exact function
 * `index.ts`'s own entry point calls, not a reimplementation of its mapping.
 */
describe("the real commander boundary reaches CliFlags correctly (item 258)", () => {
  function parseFlags(argv: string[]) {
    const program = buildRealCommand();
    program.parse(argv, { from: "user" });
    const options = program.opts();
    return buildCliFlags(options, false, ["node", "zone", ...argv]);
  }

  it("--no-revision sets CliFlags.noRevision — through the real parser, not a hand-built object", () => {
    expect(parseFlags(["--no-revision"]).noRevision).toBe(true);
  });

  it("--no-color sets CliFlags.noColor — through the real parser, not a hand-built object", () => {
    expect(parseFlags(["--no-color"]).noColor).toBe(true);
  });

  it("neither flag passed — both stay false, not true and not undefined", () => {
    // Load-bearing, not incidental: commander's own default for an unset --no-x flag is the
    // boolean `true` (verified empirically, not from commander's docs — see
    // cliOptionsIntrospection.ts), not `undefined`. A predicate that treated "unset" as "passed"
    // would fail silently here; a predicate that left the field `undefined` instead of `false`
    // would fail the strict equality below. Both wrong shapes are ruled out by this one case —
    // confirmed by mutation: reverting the fix to a bare `options.noRevision` read (the original
    // property-name bug) fails exactly this case, because the wrong property name is simply
    // absent from commander's real output and `undefined` is not `false`.
    //
    // A DIFFERENT mutation — `options.revision === false` weakened to `!options.revision` — was
    // run against this same case and found NOT load-bearing for it: every test in this file,
    // including this one, still passes. That mutation is genuinely inert, not a gap in this test —
    // commander guarantees a strict boolean for a registered `--no-x` flag, and `buildCliFlags` has
    // exactly one production call site (index.ts's own entry point), which always supplies a real
    // parsed `options` object, never a hand-built one where `undefined` could leak through. The
    // `=== false` form is kept for readability ("was this flag explicitly passed") rather than
    // because a weaker form is observably wrong.
    const flags = parseFlags([]);
    expect(flags.noRevision).toBe(false);
    expect(flags.noColor).toBe(false);
  });

  it("commander's own default for an unset --no-x flag is the boolean true, not undefined — established empirically", () => {
    const program = buildRealCommand();
    program.parse([], { from: "user" });
    const options = program.opts() as { revision?: unknown; color?: unknown };
    expect(options.revision).toBe(true);
    expect(options.color).toBe(true);
  });

  it("both flags together, and unrelated flags do not interfere", () => {
    const flags = parseFlags(["--no-revision", "--no-color", "--verbose"]);
    expect(flags.noRevision).toBe(true);
    expect(flags.noColor).toBe(true);
    expect(flags.verbose).toBe(true);
  });
});

/**
 * `--max-turns` (ledger item 259). `buildRealCommand` registers every declaration without its
 * parser, so a value would arrive as a raw string there; these cases pair index.ts's OWN declaration
 * string with index.ts's OWN exported parser, so neither is a reimplementation. The pairing itself —
 * that the declaration actually passes `parseMaxTurns` — is the one thing those two facts cannot
 * establish between them, so it is asserted structurally over the AST below rather than assumed.
 */
describe("--max-turns reaches CliFlags through the real parser (item 259)", () => {
  const MAX_TURNS_DECL = extractDeclaredOptionStrings().find((d) => d.startsWith("--max-turns"))!;

  function parseTurns(argv: string[]): unknown {
    const program = new Command();
    program.exitOverride();
    program.option(MAX_TURNS_DECL, "x", parseMaxTurns);
    program.parse(argv, { from: "user" });
    return program.opts()["maxTurns"];
  }

  it("the declaration still exists in index.ts and is the one under test", () => {
    expect(MAX_TURNS_DECL).toBe("--max-turns <n>");
  });

  it("--max-turns 5 arrives as the number 5, not the string \"5\"", () => {
    expect(parseTurns(["--max-turns", "5"])).toBe(5);
  });

  it("unset leaves maxTurns undefined — no accidental default ceiling", () => {
    expect(parseTurns([])).toBeUndefined();
  });

  it.each(["0", "-1", "abc", "2.5", ""])(
    "--max-turns %s is rejected at parse rather than silently ignored",
    (bad) => {
      expect(() => parseTurns(["--max-turns", bad])).toThrow(/positive whole number/);
    }
  );

  it("reaches CliFlags.maxTurns through buildCliFlags", () => {
    expect(buildCliFlags({ maxTurns: 7 }, false, ["node", "zone"]).maxTurns).toBe(7);
  });

  it("index.ts's own --max-turns declaration passes parseMaxTurns as its parser (the pairing)", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "index.ts"), "utf8");
    const sf = ts.createSourceFile("index.ts", src, ts.ScriptTarget.Latest, true);
    let parserArg: string | null = null;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "option" &&
        node.arguments.length >= 3 &&
        ts.isStringLiteral(node.arguments[0]!) &&
        node.arguments[0].text.startsWith("--max-turns")
      ) {
        parserArg = node.arguments[2]!.getText();
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(parserArg).toBe("parseMaxTurns");
  });
});

describe("--max-budget-usd reaches CliFlags through the real parser (item 259)", () => {
  const DECL = extractDeclaredOptionStrings().find((d) => d.startsWith("--max-budget-usd"))!;

  function parseBudget(argv: string[]): unknown {
    const program = new Command();
    program.exitOverride();
    program.option(DECL, "x", parseMaxBudgetUsd);
    program.parse(argv, { from: "user" });
    return program.opts()["maxBudgetUsd"];
  }

  it("--max-budget-usd 2.50 arrives as the number 2.5 — fractional dollars are valid", () => {
    expect(parseBudget(["--max-budget-usd", "2.50"])).toBe(2.5);
  });

  it("a sub-cent cap is accepted — unlike --max-turns, non-integers are meaningful here", () => {
    expect(parseBudget(["--max-budget-usd", "0.005"])).toBe(0.005);
  });

  it("unset leaves maxBudgetUsd undefined — no accidental default ceiling", () => {
    expect(parseBudget([])).toBeUndefined();
  });

  it.each(["0", "-1", "abc", "", "NaN", "Infinity"])(
    "--max-budget-usd %s is rejected at parse rather than silently ignored",
    (bad) => {
      expect(() => parseBudget(["--max-budget-usd", bad])).toThrow(/positive number of dollars/);
    }
  );

  it("reaches CliFlags.maxBudgetUsd through buildCliFlags", () => {
    expect(buildCliFlags({ maxBudgetUsd: 3 }, false, ["node", "zone"]).maxBudgetUsd).toBe(3);
  });

  it("index.ts's own --max-budget-usd declaration passes parseMaxBudgetUsd as its parser", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "index.ts"), "utf8");
    const sf = ts.createSourceFile("index.ts", src, ts.ScriptTarget.Latest, true);
    let parserArg: string | null = null;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "option" &&
        node.arguments.length >= 3 &&
        ts.isStringLiteral(node.arguments[0]!) &&
        node.arguments[0].text.startsWith("--max-budget-usd")
      ) {
        parserArg = node.arguments[2]!.getText();
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(parserArg).toBe("parseMaxBudgetUsd");
  });

  it("its description no longer claims the flag is unimplemented", () => {
    expect(DECL).toBe("--max-budget-usd <n>");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "index.ts"), "utf8");
    const line = src.split(/\r?\n/).find((l) => l.includes("--max-budget-usd"))!;
    expect(line).not.toContain("not implemented");
  });
});

describe("--add-dir is gone (item 259)", () => {
  it("no longer appears in index.ts's declared options", () => {
    expect(extractDeclaredOptionStrings().some((d) => d.includes("--add-dir"))).toBe(false);
  });
});
