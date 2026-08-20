import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Every field the usage extractor produces must be declared on the record type
 * that persists it (ledger item 239).
 *
 * The defect this exists to prevent, which already happened once: `extractUsage`
 * returns a `UsageBreakdown`, `recordFromResponse` spreads it whole into
 * `recordExecution`, and `recordExecution` is declared against `UsageRecord`.
 * TypeScript does not apply excess property checking to a spread variable, so a
 * field present on the breakdown and absent from the record type-checks, is
 * written to disk, and is invisible to anyone reading the record type.
 * `output_reasoning` did exactly that: 2,990 of 8,098 records in the daily
 * ledger carried it while the type said it did not exist, and a commit message
 * concluded from reading the type that reasoning counts never reach the ledger.
 *
 * Declaring that one field fixes the instance. This fixes the class: the next
 * field added to `UsageBreakdown` fails here instead of appearing silently on
 * disk months later.
 *
 * WHAT THIS COVERS: one direction, presence only, between exactly two named
 * interfaces in two named files — every `UsageBreakdown` field is declared on
 * `UsageRecord`.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, so its silence is not over-read:
 *  - Types. `output_reasoning?: number` and `output_reasoning?: string` both
 *    pass. This is a presence check, not a shape check.
 *  - Optionality. Whether a field is optional is a decision about existing
 *    records, not something parity can determine.
 *  - The reverse direction. `UsageRecord` legitimately declares fields the
 *    breakdown never supplies (`latencyMs`, `terminationReason`, the subagent
 *    fields), so requiring the reverse would fail on correct code.
 *  - What is actually on disk. That is a measurement against `~/.zone/usage/`,
 *    a gitignored path this test does not read; the figures above came from
 *    `command grep` and a JSON key scan agreeing at 17 keys.
 *  - Any other spread-into-a-narrower-parameter site in the tree. Scoped to the
 *    one pair where the defect was observed, deliberately, rather than asserting
 *    a repo-wide rule this file cannot justify.
 */

const REPO_ROOT = path.resolve(__dirname, "..");
const BREAKDOWN_FILE = path.join(REPO_ROOT, "src/llm/recordingClient.ts");
const RECORD_FILE = path.join(REPO_ROOT, "src/usage/usageTracker.ts");

/** Strip block and line comments so prose inside a doc comment cannot be read as
 *  a field. Without this, a comment mentioning a field name followed by a colon
 *  would be counted as a declaration. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Field names declared on an interface, matched in KEY-VALUE form (`name:` or
 * `name?:`) rather than by line ending. A line-end pattern would miss every
 * field whose type sits on the same line, which is all of them here.
 */
export function extractInterfaceFields(source: string, interfaceName: string): string[] {
  const stripped = stripComments(source);
  const opener = new RegExp(`interface\\s+${interfaceName}\\s*\\{`);
  const start = stripped.search(opener);
  if (start === -1) {
    throw new Error(
      `interface ${interfaceName} not found — it was renamed or moved, and this ` +
        `guard is reporting that rather than passing by matching nothing.`
    );
  }
  const bodyStart = stripped.indexOf("{", start) + 1;
  let depth = 1;
  let i = bodyStart;
  for (; i < stripped.length && depth > 0; i += 1) {
    if (stripped[i] === "{") depth += 1;
    else if (stripped[i] === "}") depth -= 1;
  }
  const body = stripped.slice(bodyStart, i - 1);
  return [...body.matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1]!);
}

describe("every UsageBreakdown field is declared on UsageRecord (item 239)", () => {
  it("has no field that persists without being declared", () => {
    const breakdown = extractInterfaceFields(
      fs.readFileSync(BREAKDOWN_FILE, "utf8"),
      "UsageBreakdown"
    );
    const record = extractInterfaceFields(fs.readFileSync(RECORD_FILE, "utf8"), "UsageRecord");
    const undeclared = breakdown.filter((f) => !record.includes(f));
    expect(undeclared).toEqual([]);
  });

  it("the extractor is not vacuous — it finds the real fields in both files", () => {
    // Guards the guard. If the regex or the brace walk drifted, the check above
    // would pass by comparing two empty lists. These anchor field names are load
    // -bearing on both sides of the comparison and predate this guard.
    const breakdown = extractInterfaceFields(
      fs.readFileSync(BREAKDOWN_FILE, "utf8"),
      "UsageBreakdown"
    );
    const record = extractInterfaceFields(fs.readFileSync(RECORD_FILE, "utf8"), "UsageRecord");
    expect(breakdown).toContain("input_uncached");
    expect(breakdown).toContain("output_reasoning");
    expect(breakdown.length).toBeGreaterThanOrEqual(6);
    expect(record).toContain("est_cost_usd");
    expect(record).toContain("output");
    expect(record.length).toBeGreaterThanOrEqual(16);
  });

  it("reads the key-value form, not a line-end form", () => {
    const sample = `interface Sample {\n  alpha: number;\n  beta?: string;\n}`;
    expect(extractInterfaceFields(sample, "Sample")).toEqual(["alpha", "beta"]);
  });

  it("does not read a field name out of a doc comment", () => {
    // The real UsageRecord's own comment names output_reasoning in prose; if
    // comments were scanned, a field could look declared while being absent.
    const sample = `interface Sample {\n  /** mentions ghost: in prose */\n  alpha: number;\n}`;
    expect(extractInterfaceFields(sample, "Sample")).toEqual(["alpha"]);
  });

  it("reports a renamed interface rather than passing on an empty match", () => {
    expect(() => extractInterfaceFields(`interface Other {}`, "Sample")).toThrow(/not found/);
  });
});
