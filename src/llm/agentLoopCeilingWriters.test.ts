import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Structural guard over every site that can set the agent loop's iteration ceiling — ledger item
 * 259's load-bearing artifact.
 *
 * WHY IT EXISTS. `--max-turns` is enforced by clamping at two points: once after the tier block,
 * once at the soft-promotion site. That is complete only because every OTHER writer of
 * `maxIterationsForRun` either runs before the clamp or is provably unreachable for a main loop —
 * in particular `iterationBudget = coachingDecision.newIterationBudget`, which reaches
 * `maybeGrantEscalationBonus` inside `CoachingController` but is gated on `escalationEnabled`, and
 * the tier block sets that false for every main loop. Completeness therefore rests on the CURRENT
 * shape of the file, not on anything structural. A seventh writer added later would silently
 * reopen the hole with nothing objecting. This guard is what objects.
 *
 * WHAT IT COVERS: object-literal properties named `maxIterationsForRun`, direct assignments to a
 * `.maxIterationsForRun` property, and whole-object `iterationBudget = …` reassignments, across all
 * of `src/`, production files only.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, stated so the boundary is documented rather than discovered:
 *   - Test files. They construct budgets freely and constraining that would be noise.
 *   - The loop's *read* of the ceiling (`iter < iterationBudget.maxIterationsForRun`). There is
 *     exactly one such condition today, but this guard is about who can WRITE the ceiling; a second
 *     read site would be harmless, a second writer is the hazard.
 *   - Indirect mutation through a helper that receives the budget object and returns a new one.
 *     `maybeGrantEscalationBonus` is exactly that shape and IS caught here, because its return
 *     value lands on one of the tracked `iterationBudget = …` reassignments — but a future helper
 *     whose result is threaded somewhere this scan does not follow would escape. The counts below
 *     are a tripwire, not a proof of exhaustiveness, and calling them one would be the same
 *     overclaim this document's own instruments are repeatedly caught making.
 *
 * The locked counts are deliberately measured AFTER every other edit this pass made, mirroring
 * `deferredWorkPositionalSweep.ts`'s own standing rule for its stored absolutes: if one drifts,
 * scan the drifting pass's own added lines first.
 */

const SRC_ROOT = path.resolve(import.meta.dirname, "..");

/** Locked; a change here must be a deliberate diff to this file, never a quiet bump. */
const EXPECTED_CEILING_WRITERS = 6;
const EXPECTED_BUDGET_REASSIGNMENTS = 5;

interface Site { file: string; text: string }

function productionSourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "__tests__") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  })(SRC_ROOT);
  return out;
}

/**
 * `propertyName` and `budgetIdentifier` are parameters rather than constants so the guard's own
 * detection logic can be pointed at something that cannot match — see the detector cases below.
 */
function findCeilingSites(
  files: string[],
  propertyName = "maxIterationsForRun",
  budgetIdentifier = "iterationBudget",
  sourceOverride?: Map<string, string>,
): { writers: Site[]; reassignments: Site[] } {
  const writers: Site[] = [];
  const reassignments: Site[] = [];
  for (const f of files) {
    const text = sourceOverride?.get(f) ?? fs.readFileSync(f, "utf8");
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    const rel = path.relative(SRC_ROOT, f);
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText() === propertyName)
        writers.push({ file: rel, text: node.getText().slice(0, 70).replace(/\s+/g, " ") });
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === propertyName
      )
        writers.push({ file: rel, text: node.getText().slice(0, 70).replace(/\s+/g, " ") });
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        node.left.text === budgetIdentifier
      )
        reassignments.push({ file: rel, text: node.getText().slice(0, 70).replace(/\s+/g, " ") });
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { writers, reassignments };
}

describe("every site that can raise the agent loop's iteration ceiling is known (item 259)", () => {
  const files = productionSourceFiles();
  const { writers, reassignments } = findCeilingSites(files);

  it("scans a real, non-trivial tree — not vacuous", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(writers.length).toBeGreaterThan(0);
    expect(reassignments.length).toBeGreaterThan(0);
  });

  it("finds exactly the known number of ceiling writers", () => {
    expect(writers).toHaveLength(EXPECTED_CEILING_WRITERS);
  });

  it("finds exactly the known number of whole-budget reassignments", () => {
    expect(reassignments).toHaveLength(EXPECTED_BUDGET_REASSIGNMENTS);
  });

  it("every one of them lives in agentLoop.ts — a writer in another module is the real hazard", () => {
    const stray = [...writers, ...reassignments]
      .filter((s) => s.file !== path.join("llm", "agentLoop.ts"))
      .map((s) => `${s.file}: ${s.text}`);
    expect(stray).toEqual([]);
  });

  it("the user-cap clamp and the promotion clamp are both present", () => {
    expect(writers.some((w) => w.text.includes("input.userMaxTurns"))).toBe(true);
    expect(writers.some((w) => w.text.includes("Math.min("))).toBe(true);
  });

  // ── detector cases: mutate what the guard DETECTS WITH, not what it guards ────────────────────
  // A set-equality guard over six names passes just as happily at zero-equals-zero. These prove the
  // extractor is actually reading the tree rather than agreeing with itself.

  it("detector: a property name that cannot match finds nothing, proving the name is load-bearing", () => {
    const { writers: none } = findCeilingSites(files, "maxIterationsForRunXX");
    expect(none).toEqual([]);
  });

  it("detector: an identifier that cannot match finds no reassignments", () => {
    const { reassignments: none } = findCeilingSites(files, "maxIterationsForRun", "iterationBudgetXX");
    expect(none).toEqual([]);
  });

  it("detector: removing one real writer from the scanned text lowers the count by exactly one", () => {
    const agentLoop = files.find((f) => f.endsWith(path.join("llm", "agentLoop.ts")))!;
    const original = fs.readFileSync(agentLoop, "utf8");
    const withoutUserClamp = original.replace(
      "maxIterationsForRun: input.userMaxTurns",
      "somethingElseEntirely: input.userMaxTurns",
    );
    expect(withoutUserClamp).not.toBe(original);
    const { writers: fewer } = findCeilingSites(
      files, "maxIterationsForRun", "iterationBudget",
      new Map([[agentLoop, withoutUserClamp]]),
    );
    expect(fewer).toHaveLength(EXPECTED_CEILING_WRITERS - 1);
  });

  it("detector: an empty file list yields empty sets, so the counts cannot come from nowhere", () => {
    const { writers: none, reassignments: alsoNone } = findCeilingSites([]);
    expect(none).toEqual([]);
    expect(alsoNone).toEqual([]);
    // and the locked expectations are themselves non-zero, so an empty scan can never satisfy them
    expect(EXPECTED_CEILING_WRITERS).toBeGreaterThan(0);
    expect(EXPECTED_BUDGET_REASSIGNMENTS).toBeGreaterThan(0);
  });
});
