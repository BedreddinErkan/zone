import { describe, expect, it } from "vitest";
import { buildCliFlags } from "./index.js";
import { buildRealCommand } from "./cliOptionsIntrospection.js";

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
