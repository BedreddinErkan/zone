import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Items 254/255: `costUsd` silently missed whole LLM calls because `agentLoop.ts` had five
 * `createChatCompletion` call sites and only two fed `budget.recordLLMCall` — the other three,
 * plus a sixth reached indirectly via `checkAndMaybeCompact`, were unfed. The stopgap fix pairs
 * all six; this guards against a seventh going unpaired the same way, which item 255 names as
 * the real defect: call and recording are separable by construction, so nothing stops it.
 *
 * WHY THIS SCAN IS SCOPED TO ONE FILE, NOT THE WHOLE TREE. A full-tree `createChatCompletion`
 * enumeration was run to check this (`command grep`/`git grep`, 20 matches). Eight of those are
 * real invocations outside this file — `generateFinalRunReport.ts`, `executionPlan.ts`,
 * `planFeature.ts`, `planFullPatch.ts` (×2), `plannerStep.ts`, `planPatchPreview.ts`,
 * `refinePrompt.ts`, `taskClassifier.ts` — and none of them has a `TokenBudgetMeter` in scope at
 * all. Asserting they "reach `recordLLMCall` or are declared exempt" would be incoherent:
 * `recordLLMCall` is not reachable there, so there is nothing to be exempt from. `agentLoop.ts`
 * is the only file where the invariant is coherent to check, because it is the only file where
 * `budget` exists.
 *
 * WHY SEQUENTIAL PAIRING, NOT A DISTANCE WINDOW. A first version of this test used "a
 * recordLLMCall within N lines forward" (calibrated to the six real pairings' own 12-49 line
 * span). Running it against a deliberately unpaired mutation planted near an unrelated real
 * pairing (this file's own mutation-testing pass, not a hypothetical) produced a FALSE NEGATIVE:
 * the mutated call's window happened to reach the next call's own real `recordLLMCall`, so an
 * unpaired call read as paired. A window has no notion of WHICH call a given record belongs to.
 * Sequential pairing does: walk the file top-to-bottom tracking one "pending" call at a time: a
 * `createChatCompletion`/`checkAndMaybeCompact` while one is already pending means the PRIOR call
 * was never recorded before the next one started, which is flagged directly — this is the actual
 * shape of the defect (a call site with nothing between it and the next call except silence), not
 * a distance proxy for it.
 */
describe("agentLoop.ts: every LLM call site feeds the cost meter (item 255)", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..");
  const AGENT_LOOP = "src/llm/agentLoop.ts";
  const CALL_RE = /createChatCompletion\(|checkAndMaybeCompact\(/;
  const RECORD_RE = /recordLLMCall\(/;

  function lines(): string[] {
    return fs.readFileSync(path.join(REPO_ROOT, AGENT_LOOP), "utf8").split("\n");
  }

  /** Sequential state machine: at most one call is ever "pending" at a time. A new call site
   *  found while one is already pending means the pending one reached the next call with no
   *  record in between — that is the defect shape, reported by the pending call's own line. */
  function findUnpaired(fileLines: string[]): { pendingLine: number; unresolved: number[] } {
    let pending: number | null = null;
    const unresolved: number[] = [];
    fileLines.forEach((line, idx) => {
      const lineNo = idx + 1;
      if (CALL_RE.test(line)) {
        if (pending !== null) unresolved.push(pending);
        pending = lineNo;
      } else if (RECORD_RE.test(line) && pending !== null) {
        pending = null;
      }
    });
    if (pending !== null) unresolved.push(pending);
    return { pendingLine: pending ?? -1, unresolved };
  }

  it("finds a real, non-zero number of call sites — the scan is not vacuous", () => {
    const fileLines = lines();
    const callCount = fileLines.filter((l) => CALL_RE.test(l)).length;
    const recordCount = fileLines.filter((l) => RECORD_RE.test(l)).length;
    expect(callCount, "createChatCompletion/checkAndMaybeCompact call sites").toBeGreaterThanOrEqual(6);
    expect(recordCount, "recordLLMCall sites").toBeGreaterThanOrEqual(6);
  });

  it("every LLM/compaction call site in agentLoop.ts is paired with a recordLLMCall before the next call starts", () => {
    const { unresolved } = findUnpaired(lines());
    expect(
      unresolved,
      unresolved.length === 0
        ? ""
        : `Call(s) at line(s) ${unresolved.join(", ")} in ${AGENT_LOOP} reach the next ` +
          `createChatCompletion/checkAndMaybeCompact (or end of file) with no budget.recordLLMCall ` +
          `in between — this is exactly the defect items 254/255 fixed. Add the recording call, ` +
          `matching the pattern already at the continuation call site.`
    ).toEqual([]);
  });
});
