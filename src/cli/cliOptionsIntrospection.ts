import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";

const INDEX_TS_PATH = path.resolve(import.meta.dirname, "index.ts");

/**
 * The `.option()` declaration strings in index.ts's own `program` chain, extracted by regex over
 * the source text — the raw input both `cliOptionsCoverage.test.ts` (the structural guard) and
 * `index.optionsBoundary.test.ts` (the real-parser boundary test) need to reconstruct commander's
 * actual behaviour.
 *
 * Deliberately shared as one function rather than reimplemented in each test file. This is a
 * different kind of sharing than the one that produced a false agreement two passes ago: there,
 * two instruments shared a hand-DERIVED mapping (an interpretation of the declarations), so a
 * wrong interpretation was invisible to both. Here what is shared is the literal source text
 * itself, which is either a faithful copy of the declarations or it is not — independent of both
 * defects this module's two callers each check (a wrong property name on the read side; a wrong
 * CliFlags mapping on the boundary-test side). A bug in this extraction (an omitted or garbled
 * declaration) is exactly what `cliOptionsCoverage.test.ts`'s own mutation-tested fixture proves
 * gets caught rather than silently agreed with.
 */
export function extractDeclaredOptionStrings(sourceText?: string): string[] {
  const src = sourceText ?? fs.readFileSync(INDEX_TS_PATH, "utf8");
  return [...src.matchAll(/\.option\(\s*"([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * A fresh, real `commander.Command` with every declared option registered — fresh because
 * `Command`/`.parse()` is stateful and each caller needs its own instance to parse independently.
 * `allowUnknownOption` because this reconstructs only the option surface, not the `[query...]`
 * argument or the `login` subcommand.
 */
export function buildRealCommand(declarations: string[] = extractDeclaredOptionStrings()): Command {
  const program = new Command();
  for (const decl of declarations) {
    program.option(decl, "x");
  }
  program.allowUnknownOption(true);
  return program;
}

/**
 * Parses an argv exercising every declared flag at once and returns the property names commander
 * actually produces — commander's own naming behaviour, established empirically rather than from
 * its documentation (see ledger item 258): a `--foo-bar` flag yields `fooBar`, and a `--no-x` flag
 * yields `x`, defaulting to `true` when absent and `false` when passed — never `noX`.
 */
export function producedOptionKeys(declarations: string[] = extractDeclaredOptionStrings()): Set<string> {
  const program = buildRealCommand(declarations);
  const argv: string[] = [];
  for (const decl of declarations) {
    const m = /--([a-z0-9-]+)/.exec(decl);
    if (!m) continue;
    argv.push(`--${m[1]}`);
    if (/<[^>]+>/.test(decl)) argv.push("1");
  }
  program.parse(argv, { from: "user" });
  return new Set(Object.keys(program.opts()));
}
