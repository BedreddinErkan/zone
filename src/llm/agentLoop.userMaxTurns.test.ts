/**
 * `--max-turns` / `AgentLoopInput.userMaxTurns` — ledger item 259.
 *
 * WHAT THIS PINS, and why each case exists rather than resting on a source-read argument:
 *
 *  1. The cap BINDS below the computed tier budget, and lowers nothing at or above it. The second
 *     half is what makes it a ceiling rather than an override upward, and it is asserted on the
 *     `[zone-user-iter-cap]` marker — emitted only when the clamp actually fires — so "did not
 *     lower anything" is observed rather than inferred from a run that looks the same either way.
 *
 *  2. Soft promotion cannot cross the cap. Promotion is *designed* to relax a dispatcher-sized
 *     `maxIterationsOverride`; without the `Math.min` at its site, `--max-turns 3` on a run whose
 *     archetype pipeline applied would legitimately reach `input.maxIterations` (45 at the default
 *     medium tier). The case is built so promotion definitely fires (`inputIterCap` reached), not so
 *     that it merely might.
 *
 *  3. The coaching path cannot raise the ceiling either. This one is here because the completeness
 *     argument for clamping at a single promotion site rests on a chain of three source-read claims
 *     — `CoachingController` gates its escalation bonus on `escalationEnabled`, that value is
 *     captured by value at construction, and the tier block sets it false before then "for EVERY
 *     main loop". Reading is guessing, so the chain is verified behaviourally instead: drive a main
 *     loop into repeated same-file failures until the controller's own repeat-detection fires, and
 *     assert the ceiling still holds. The repeat-detected assertion is what stops this passing
 *     vacuously if the coaching path is never reached at all.
 *
 *  4. Subagents do NOT inherit the cap — a deliberate decision, pinned so that a later pass
 *     "fixing" inheritance has something object to it. Note the deliberate asymmetry against the
 *     deferred `--max-budget-usd`, where subagent spend DOES count against the parent, because
 *     `TokenBudgetMeter.snapshot().costUsd` already returns
 *     `_iterCostAccumulator.total_cost + _subagentCostTotal`. Turns are per-loop; dollars are
 *     per-run. Both halves are recorded in item 259 so the pair is not later mistaken for an
 *     inconsistency.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

const toolExecutorMock = vi.hoisted(() => ({
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  clearCommandCacheForRun: vi.fn(),
  clearCommandCacheForTest: vi.fn(),
  clearOutlineCacheForTest: vi.fn(),
  isMemoizableCommand: vi.fn(),
  computeCommandFingerprint: vi.fn(),
  truncateCommandOutput: vi.fn(),
  resolveAgentPath: vi.fn(),
  resolveRunCommandCwd: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ createChatCompletion: vi.fn() }));
const loggerMock = vi.hoisted(() => ({ debugLog: vi.fn(), errorLog: vi.fn(), log: vi.fn() }));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));
vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);
vi.mock("../utils/logger.js", () => loggerMock);

import { runAgentLoop } from "./agentLoop.js";

/** Distinct `_n` per call so the loop detector (4 identical tool+args hashes) never fires. */
function llmReadFile(i: number) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: `rf-${i}`, type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ filePath: "src/a.ts", _n: i }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Same file every time, and always failing — this is what drives detectRepeatedFailure. */
function llmFailingPatch(i: number) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: `ap-${i}`, type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ filePath: "src/repeat.ts", patch: `--- FIND ---\nx${i}\n--- REPLACE ---\ny` }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function userIterCapMarkers() {
  return loggerMock.log.mock.calls.filter((a: unknown[]) =>
    String(a[0]).includes("[zone-user-iter-cap]"));
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-usermaxturns-"));
  resetToolExecutorMock(toolExecutorMock);
  toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
    if (name === "read_file") return { success: true, output: "// content" };
    return { success: false, output: "unsupported" };
  });
  toolExecutorMock.withStagingTempFlush.mockResolvedValue(undefined);
  mocks.createChatCompletion.mockReset();
  loggerMock.debugLog.mockReset();
  loggerMock.errorLog.mockReset();
  loggerMock.log.mockReset();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("userMaxTurns binds as a ceiling (item 259)", () => {
  it("a cap below the computed budget stops the run at the cap", async () => {
    let i = 0;
    mocks.createChatCompletion.mockImplementation(async () => llmReadFile(i++));

    const result = await runAgentLoop({
      task: "implement the feature in the codebase",
      repoPath,
      mode: "patch",
      userMaxTurns: 3,
    });

    expect(result.iterCount).toBe(3);
    // NOT "max_iterations". Exhausting the iteration budget reports `token_budget_exceeded` — one
    // of the three naming inconsistencies CLAUDE.md records as preserved verbatim (Gap 12). This
    // pass planned to "reuse max_iterations" and that premise was simply wrong about what the
    // existing exit already reports; measured here rather than assumed. The decision it was meant
    // to serve still holds — no new terminationReason member, no new consumer surface — but the
    // reason a user's cap surfaces under is this misnomer, which is exactly why the
    // `[zone-user-iter-cap]` marker below is the thing that actually identifies the binding
    // constraint.
    expect(result.terminationReason).toBe("token_budget_exceeded");
    const markers = userIterCapMarkers();
    expect(markers).toHaveLength(1);
    expect(JSON.parse(String(markers[0]![1])).userMaxTurns).toBe(3);
  });

  it("a cap far above the computed budget lowers nothing — no clamp fires", async () => {
    let i = 0;
    mocks.createChatCompletion.mockImplementation(async () =>
      i++ < 1 ? llmReadFile(i) : {
        choices: [{ message: { content: "Done. [ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    await runAgentLoop({
      task: "implement the feature in the codebase",
      repoPath,
      mode: "patch",
      userMaxTurns: 9999,
    });

    // The marker is emitted only when the clamp actually lowers the budget.
    expect(userIterCapMarkers()).toHaveLength(0);
  });
});

describe("nothing downstream may raise the ceiling past the cap (item 259)", () => {
  it("soft promotion cannot cross it", async () => {
    let i = 0;
    mocks.createChatCompletion.mockImplementation(async () => llmReadFile(i++));

    // inputIterCap = maxIterationsOverride (2) because pipelineApplied is true, so promotion fires
    // at iter 1 on the "iter_cap" trigger and tries to reopen the budget to input.maxIterations.
    const result = await runAgentLoop({
      task: "implement the feature in the codebase",
      repoPath,
      mode: "patch",
      userMaxTurns: 3,
      maxIterations: 45,
      maxIterationsOverride: 2,
      pipelineApplied: true,
      originalArchetype: "targeted_fix",
    });

    // Promotion did reopen the budget (2 -> 3), but only as far as the user's cap. Unclamped it
    // would be 45.
    expect(result.promotionTrigger).toBe("iter_cap");
    expect(result.iterCount).toBe(3);
  });

  it("the coaching path cannot either — verified by driving it, not by reading it", async () => {
    let i = 0;
    mocks.createChatCompletion.mockImplementation(async () => llmFailingPatch(i++));
    toolExecutorMock.executeTool.mockImplementation(async () => ({
      success: false,
      output: "apply_patch failed: FIND block not found in src/repeat.ts",
      error: "apply_patch_find_not_found",
    }));

    const progress: string[] = [];
    const result = await runAgentLoop({
      task: "implement the feature in the codebase",
      repoPath,
      mode: "patch",
      userMaxTurns: 5,
      maxIterations: 45,
      onProgress: (m: string) => progress.push(m),
    });

    // Non-vacuity: the coaching controller's repeat-detection must actually have fired, otherwise
    // this proves only that a short run is short.
    expect(progress.some((m) => m.includes("zone-agent-repeat-detected"))).toBe(true);
    expect(result.iterCount).toBe(5);
  });
});

/**
 * Added because predicting this pass's own mutation set surfaced the gap: dropping `userMaxTurns`
 * from one of dispatch.ts's three `runLlmPatchFlow` call sites would have killed no test at all.
 * A flag that works on two code paths and silently does nothing on the third is precisely the bug
 * class item 258 closed and this entry continues, so the threading gets a guard rather than trust.
 */
describe("every dispatch path forwards the cap (item 259)", () => {
  it("all runLlmPatchFlow call sites in dispatch.ts pass userMaxTurns", () => {
    const file = path.resolve(import.meta.dirname, "../cli/dispatch.ts");
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const missing: number[] = [];
    let total = 0;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "runLlmPatchFlow" &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0]!)
      ) {
        total += 1;
        const forwards = node.arguments[0].properties.some(
          (p) => p.name?.getText() === "userMaxTurns"
        );
        if (!forwards) missing.push(sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(total).toBe(3); // anti-vacuity: the scan must actually find the call sites
    expect(missing).toEqual([]);
  });
});

describe("subagents do not inherit the cap — a decision, pinned (item 259)", () => {
  it("the subagent spawn site never forwards userMaxTurns", () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../tools/toolExecutor.ts"), "utf8");
    expect(src).not.toContain("userMaxTurns");
    // ...and it does pass a budget, so the absence above is a deliberate choice of WHICH budget,
    // not a spawn site that forgot to bound its subagent at all.
    expect(src).toContain("maxIterationsOverride: subagentTypeMaxIterations(");
  });
});
