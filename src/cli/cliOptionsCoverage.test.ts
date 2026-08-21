import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { extractDeclaredOptionStrings, producedOptionKeys } from "./cliOptionsIntrospection.js";

/**
 * The structural guard behind ledger item 258, landed as a permanent regression check rather than
 * a one-off establishment script. `program.opts<CliOptions>()` is an unchecked generic against a
 * hand-written interface, so any property name typechecks whether commander produces it or not —
 * which is how `options.noRevision`/`options.noColor` survived `tsc`, review, and their own unit
 * tests. Type derivation from the declarations was established as not reachable: commander
 * 12.1.0's own `.option()` returns `this` unconditionally
 * (`node_modules/commander/typings/index.d.ts`), with no accumulating generic to derive from. This
 * guard is the remedy that is reachable.
 *
 * WHAT THIS COVERS: every property read as `options.X` in `index.ts` (receiver-scoped — a
 * whole-tree scan for a common name like `.name` collides with unrelated accesses, the exact gap
 * that missed `--name` in the enumeration pass that opened this item) must be a member of the set
 * commander actually produces from `index.ts`'s own declared options.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: `options.trust` and `options.noTrust`. Both are declared on
 * `CliOptions` and neither is ever read as `options.trust`/`options.noTrust` anywhere in the file —
 * confirmed by this same scan, which finds zero occurrences of either name in the read set. This
 * is not an exemption from a check that would otherwise fire; the guard only evaluates reads that
 * exist, and these reads do not exist. `parseTrustFlag(process.argv)` is documented in `index.ts`'s
 * own comment as "the sole authoritative source" for trust, deliberately bypassing `options`
 * entirely — so there is nothing here to flag, structurally, not by omission.
 *
 * The extraction this guard shares with `index.optionsBoundary.test.ts`
 * (`extractDeclaredOptionStrings`/`producedOptionKeys`) is documented in
 * `cliOptionsIntrospection.ts`'s own header — a shared ground-truth input, not a shared
 * derivation, and `"the shared extraction is itself wrong"` is what the "produced keys from an
 * incomplete list" test below exists to rule out.
 */

const INDEX_TS_PATH = path.resolve(import.meta.dirname, "index.ts");

/** Receiver-scoped: only `options.X`, matching the exact shape the real defect had. */
function readOptionsProperties(sourceText: string, receiver = "options"): string[] {
  const sf = ts.createSourceFile("index.ts", sourceText, ts.ScriptTarget.Latest, true);
  const reads = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === receiver
    ) {
      reads.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...reads];
}

describe("every options.X read in index.ts is a property commander actually produces (item 258)", () => {
  const sourceText = fs.readFileSync(INDEX_TS_PATH, "utf8");
  const reads = readOptionsProperties(sourceText);
  const produced = producedOptionKeys();

  it("finds a real, non-zero number of reads and produced keys — not vacuous", () => {
    expect(reads.length).toBeGreaterThan(20);
    expect(produced.size).toBeGreaterThan(20);
  });

  it("has no read that commander does not produce", () => {
    const orphaned = reads.filter((r) => !produced.has(r)).sort();
    expect(orphaned).toEqual([]);
  });

  it("options.trust and options.noTrust are confirmed absent from the read set, not silently exempted", () => {
    expect(reads).not.toContain("trust");
    expect(reads).not.toContain("noTrust");
  });

  it("the receiver-scoped extractor does not collide on a common property name like a whole-tree scan would", () => {
    const sample = `
      for (const { name, re } of namedPatterns) { use(name); }
      const x = options.name;
    `;
    expect(readOptionsProperties(sample)).toEqual(["name"]);
  });

  it("guard-detection: pointing the scan at a receiver that cannot match finds nothing, proving the receiver name is load-bearing", () => {
    expect(readOptionsProperties(sourceText, "opts")).toEqual([]);
  });

  it("guard-detection: a produced-key set built from an incomplete declaration list still disagrees with the real reads — the shared extraction being wrong does not silently pass", () => {
    const incomplete = extractDeclaredOptionStrings(sourceText).filter(
      (d) => !d.includes("--no-revision")
    );
    const producedFromIncomplete = producedOptionKeys(incomplete);
    // The real code still reads `options.revision` (via the fix), but the incomplete list never
    // registered --no-revision, so commander never produces `revision` from it either.
    expect(reads).toContain("revision");
    expect(producedFromIncomplete.has("revision")).toBe(false);
    const orphanedUnderIncompleteExtraction = reads.filter((r) => !producedFromIncomplete.has(r));
    expect(orphanedUnderIncompleteExtraction).toContain("revision");
  });
});
