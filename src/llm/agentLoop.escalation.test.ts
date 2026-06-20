/**
 * Escalate-on-stall Inc-1 integration tests.
 *
 * When ZONE_ESCALATE_ON_STALL=1 and the anti-thrash Stage-2 break fires with a
 * non-cost_burn signal, the loop escalates the main model one rung and continues
 * instead of hard-killing. One escalation per run; cost_burn excluded.
 *
 * WANDERING EXEMPTION NOTES:
 * detectWanderingSignal has a "broad first-time investigation" exemption:
 *   if (uniqueFiles >= wanderReadMin && totalReads < rereadFactor * uniqueFiles) return null
 * All-distinct-file reads are always exempted (uniqueFiles === totalReads, so
 * totalReads < 2 * uniqueFiles is always true). We avoid this by using only
 * 2 distinct file paths (uniqueFiles = 2 < wanderReadMin = 5, exemption never fires)
 * and a per-call nonce (_n) so hashToolCall stays unique and the loop-detector
 * (TERMINATE_THRESHOLD=4 identical hashes) never fires.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

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

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  debugLog: vi.fn(),
  errorLog: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);
vi.mock("../utils/logger.js", () => loggerMock);

// ── imports ───────────────────────────────────────────────────────────────────

import { runAgentLoop } from "./agentLoop.js";
import {
  ANTI_THRASH_WANDER_ITER_MIN,
  ANTI_THRASH_BREAK_ITERS,
  ANTI_THRASH_COST_BURN_ITER_MIN,
} from "./antiThrash.js";

// ── helpers ───────────────────────────────────────────────────────────────────

// Two distinct file paths (uniqueFiles=2 < WANDER_READ_MIN=5) used for all read_file
// calls. The nonce (_n) makes each tool call's hash unique → loop detector never fires.
const WANDER_FILES = ["src/alpha.ts", "src/beta.ts"] as const;

function llmReadFile(id: string, i: number) {
  const filePath = WANDER_FILES[i % WANDER_FILES.length]!;
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id, type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ filePath, _n: i }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// 40k prompt tokens at gpt-4o pricing ($2.50/1M) = $0.10/iter.
// After COST_BURN_ITER_MIN=10 iters: cost ≈ $1.01 > $1.00 threshold.
// runId must be set for cost to accumulate in TokenBudgetMeter.
const HIGH_COST_USAGE = { prompt_tokens: 40_000, completion_tokens: 100, total_tokens: 40_100 };

function llmRunCommand(id: string, nonce: number) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id, type: "function",
          function: { name: "run_command", arguments: JSON.stringify({ command: "tsc --noEmit", _n: nonce }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: HIGH_COST_USAGE,
  };
}

function llmDone(text = "Done. [ZONE_VERIFICATION: no_verification_attempted]") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ── fixture ───────────────────────────────────────────────────────────────────

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-escalation-"));
  resetToolExecutorMock(toolExecutorMock);
  toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
    if (name === "read_file") return { success: true, output: "// content" };
    if (name === "run_command") return { success: true, output: "" };
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
  delete process.env["ZONE_ESCALATE_ON_STALL"];
  delete process.env["ZONE_LLM_MODEL_HIGH"];
});

// ── Test: Fires (ZONE_ESCALATE_ON_STALL=1, wandering) ────────────────────────

describe("ZONE_ESCALATE_ON_STALL=1 — wandering stall triggers escalation", () => {
  it("escalates gpt-4o → gpt-5.5, emits [zone-model-escalated], run continues", async () => {
    process.env["ZONE_ESCALATE_ON_STALL"] = "1";

    // Stage-1 fires at pre-iter hook of iter WANDER_ITER_MIN=8 (after 8 reads, totalReads=8,
    // uniqueFiles=2 < WANDER_READ_MIN=5, no exemption). Stage-2 fires at iter 11 post-tool.
    // Escalation (continue) → iter 12 returns llmDone → natural completion.
    //
    // Call count: iters 0-11 use read_file (calls 1-12), iter 12 gets llmDone (call 13).
    const STAGE2_ITER = ANTI_THRASH_WANDER_ITER_MIN + ANTI_THRASH_BREAK_ITERS; // 11
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount++;
      // Reads 0..STAGE2_ITER inclusive (calls 1..STAGE2_ITER+1) trigger Stage-2 at iter 11.
      // After escalation (continue), call STAGE2_ITER+2 returns done.
      if (callCount <= STAGE2_ITER + 1) {
        return llmReadFile(`rf-${callCount}`, callCount);
      }
      return llmDone();
    });

    const result = await runAgentLoop({
      task: "implement the feature in the codebase",
      repoPath,
      mode: "patch",
      maxIterations: 30,
    });

    // Escalation prevented hard-kill: run must not terminate as semantic_stall.
    expect(result.terminationReason).not.toBe("semantic_stall");

    // [zone-model-escalated] must have been emitted via debugLog.
    const escalatedCalls = loggerMock.debugLog.mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("[zone-model-escalated]"),
    );
    expect(escalatedCalls.length).toBe(1);
    const payload = JSON.parse(escalatedCalls[0]![1] as string) as {
      from: string; to: string; pattern: string;
    };
    expect(payload.from).toBe("gpt-4o");
    expect(payload.to).toBe("gpt-5.5");
    expect(payload.pattern).toBe("wandering");

    // After escalation, subsequent adapter call(s) must use the escalated model.
    const escalatedAdapterCalls = (mocks.createChatCompletion.mock.calls as [{ model: string }][])
      .filter(([params]) => params?.model === "gpt-5.5");
    expect(escalatedAdapterCalls.length).toBeGreaterThan(0);
  });
});

// ── Test: Default OFF ─────────────────────────────────────────────────────────

describe("ZONE_ESCALATE_ON_STALL unset (default) — stall still hard-kills", () => {
  it("wandering stall → semantic_stall, no [zone-model-escalated]", async () => {
    // No ZONE_ESCALATE_ON_STALL set. Stage-2 fires at iter 11 → synthesizeStallExit.
    // Buffer 2 extra calls past iter 11 to be safe; they're never consumed.
    const TOTAL_CALLS = ANTI_THRASH_WANDER_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2; // 13
    mocks.createChatCompletion.mockImplementation(async () => {
      // Should never be called past iter 11 (stall terminates the run).
      return llmReadFile(`rf-stall`, TOTAL_CALLS);
    });
    // Seed exactly TOTAL_CALLS distinct nonces so we can count calls.
    mocks.createChatCompletion.mockReset();
    for (let i = 0; i < TOTAL_CALLS; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce(llmReadFile(`rf-${i}`, i));
    }
    // Fallback: if called past TOTAL_CALLS, throw to surface the issue clearly.
    mocks.createChatCompletion.mockImplementation(async () => {
      throw new Error("createChatCompletion called more times than expected — stall did not fire");
    });

    const result = await runAgentLoop({
      task: "implement the other feature",
      repoPath,
      mode: "patch",
      maxIterations: 30,
    });

    expect(result.terminationReason).toBe("semantic_stall");
    const escalatedCalls = loggerMock.debugLog.mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("[zone-model-escalated]"),
    );
    expect(escalatedCalls.length).toBe(0);
  });
});

// ── Test: cost_burn excluded ──────────────────────────────────────────────────

describe("ZONE_ESCALATE_ON_STALL=1 — cost_burn stall is NOT escalated", () => {
  it("cost_burn pattern → semantic_stall (escalation excluded), no [zone-model-escalated]", async () => {
    process.env["ZONE_ESCALATE_ON_STALL"] = "1";

    // Use run_command (NOT read_file) so totalReads stays 0 < WANDER_READ_MIN=5,
    // preventing wandering from firing before cost_burn.
    // HIGH_COST_USAGE: $0.10/iter × 10 iters = $1.01 > $1.00 threshold.
    // runId required for cost to accumulate in TokenBudgetMeter.
    // Stage-1 at iter COST_BURN_ITER_MIN=10, Stage-2 at iter 13.
    const STALL_ITERS = ANTI_THRASH_COST_BURN_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2; // 15
    for (let i = 0; i < STALL_ITERS; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce(llmRunCommand(`rc-${i}`, i));
    }

    const result = await runAgentLoop({
      task: "run the build repeatedly",
      repoPath,
      mode: "patch",
      maxIterations: 30,
      runId: "test-escalation-cost-burn",
    });

    expect(result.terminationReason).toBe("semantic_stall");
    // No escalation emitted even though flag is on — cost_burn is excluded.
    const escalatedCalls = loggerMock.debugLog.mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("[zone-model-escalated]"),
    );
    expect(escalatedCalls.length).toBe(0);
  });
});

// ── Test: One-shot (second stall hard-kills) ──────────────────────────────────

describe("ZONE_ESCALATE_ON_STALL=1 — one-shot: second stall hard-kills", () => {
  it("after first escalation, second wandering stall → semantic_stall", async () => {
    process.env["ZONE_ESCALATE_ON_STALL"] = "1";

    // Phase 1 (iters 0-11): 12 read_file calls → Stage-2 at iter 11 → escalation (continue).
    // Phase 2 (iters 12-15): Stage-1 re-fires at iter 12 (still wandering, Stage-1 was reset).
    //   Stage-2 at iter 12 + BREAK_ITERS = 15.
    //   escalatedModel !== null → falls through to synthesizeStallExit → semantic_stall.
    //
    // Total calls needed: iters 0-15 = 16. Use mockImplementation for infinite supply.
    mocks.createChatCompletion.mockImplementation(async (params: { model?: string }) => {
      const idx = mocks.createChatCompletion.mock.calls.length - 1;
      // Use call index as nonce for unique hashes.
      return llmReadFile(`rf-${idx}`, idx);
    });

    const FIRST_STALL = ANTI_THRASH_WANDER_ITER_MIN + ANTI_THRASH_BREAK_ITERS;   // 11
    const SECOND_STALL = FIRST_STALL + 1 + ANTI_THRASH_BREAK_ITERS;              // 15

    const result = await runAgentLoop({
      task: "check all the files for issues",
      repoPath,
      mode: "patch",
      maxIterations: SECOND_STALL + 10, // well beyond second stall
    });

    expect(result.terminationReason).toBe("semantic_stall");

    // Exactly one escalation was emitted (second stall fell through to synthesizeStallExit).
    const escalatedCalls = loggerMock.debugLog.mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("[zone-model-escalated]"),
    );
    expect(escalatedCalls.length).toBe(1);
  });
});

// ── Test: Top-rung — nextStrongerModel returns null, falls through ────────────

describe("ZONE_ESCALATE_ON_STALL=1 — top-rung model falls through to synthesizeStallExit", () => {
  it("gpt-5.5 (top of OpenAI ladder) → semantic_stall even with flag on", async () => {
    process.env["ZONE_ESCALATE_ON_STALL"] = "1";
    // Force the base model to the top rung so nextStrongerModel returns null.
    process.env["ZONE_LLM_MODEL_HIGH"] = "gpt-5.5";

    const TOTAL_CALLS = ANTI_THRASH_WANDER_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2; // 13
    for (let i = 0; i < TOTAL_CALLS; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce(llmReadFile(`rf-${i}`, i));
    }
    // Failsafe: crash if called past expected count.
    mocks.createChatCompletion.mockImplementation(async () => {
      throw new Error("createChatCompletion called more times than expected — stall did not fire");
    });

    const result = await runAgentLoop({
      task: "read all src files and propose changes",
      repoPath,
      mode: "patch",
      maxIterations: 30,
    });

    expect(result.terminationReason).toBe("semantic_stall");
    // No escalation possible — top rung, nextStrongerModel returned null.
    const escalatedCalls = loggerMock.debugLog.mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("[zone-model-escalated]"),
    );
    expect(escalatedCalls.length).toBe(0);
  });
});
