/**
 * INC-1 Anti-Thrash integration: P4 stall detection wired into agentLoop.
 *
 * Nonce strategy: _n:N in LLM args keeps patchHash stable (hashPatchBlocks reads
 * only args.patch) while making hashToolCall unique per call (includes all args)
 * so the loop-detector never fires on repeated apply_patch failures.
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
  ANTI_THRASH_BREAK_ITERS,
  ANTI_THRASH_FAILURE_COACH_MIN,
  ANTI_THRASH_WANDER_ITER_MIN,
  ANTI_THRASH_WANDER_READ_MIN,
  ANTI_THRASH_COST_BURN_ITER_MIN,
} from "./antiThrash.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const TARGET = "src/target.ts";
const OTHER  = "src/other.ts";
const PATCH  = "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;";
const FAIL_OUTPUT = "Block 1: find content not found";

function llmReadFile(id: string, filePath: string = TARGET) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ filePath }) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function llmApplyPatch(id: string, nonce: number, filePath: string = TARGET) {
  // nonce field: hashPatchBlocks ignores it (reads only args.patch) → patchHash stable;
  // hashToolCall includes it → each call is unique to the loop-detector.
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ filePath, patch: PATCH, _n: nonce }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function llmWriteFile(id: string, filePath: string = OTHER) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "write_file", arguments: JSON.stringify({ filePath, content: "const y = 2;" }) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function llmDone(text = "Done. [ZONE_VERIFICATION: no_verification_attempted]") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function llmMultiEdit(id: string, files: string[] = [TARGET]) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: {
            name: "multi_edit",
            arguments: JSON.stringify({ files, find: "const x", replace: "const y" }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// High-cost usage shape: 40K prompt tokens at gpt-4o pricing ($2.50/1M) = $0.10/iter.
// After COST_BURN_ITER_MIN=10 iters: ~$1.01 > $1.00 threshold.
// Total tokens over COST_BURN_ITER_MIN+BREAK_ITERS+1=14 iters: 14×40100=561K < 800K cap.
const HIGH_COST_USAGE = { prompt_tokens: 40000, completion_tokens: 100, total_tokens: 40100 };

function llmRunCommand(id: string, command = "tsc --noEmit", nonce?: number) {
  // nonce field: hashToolCall includes all args → each call is unique to the loop-detector
  // while parsedArgs.command stays "tsc --noEmit" for the P3 feeder classifier.
  const args = nonce !== undefined ? { command, _n: nonce } : { command };
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "run_command", arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const TSC_OUTPUT_ONE_ERROR = "src/x.ts(1,1): error TS2304: Cannot find name 'y'.";

// ── fixture ───────────────────────────────────────────────────────────────────

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-stall-detect-"));
  resetToolExecutorMock(toolExecutorMock);
  toolExecutorMock.withStagingTempFlush.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("agentLoop anti-thrash Stage 1+2 (INC-1 P4)", () => {
  it("P4 terminal: COACH_MIN+BREAK_ITERS+1 identical fails → semantic_stall", async () => {
    // iter 0: read_file (bypasses no-read gate for all subsequent apply_patch)
    // iters 1..COACH_MIN: fail → coachingAttempts reaches COACH_MIN=2
    //   pre-iter COACH_MIN+1: Stage 1 fires (antiThrashStage1FiredAtIter = COACH_MIN+1)
    // iters COACH_MIN+1..COACH_MIN+BREAK_ITERS: fail → Stage 2 armed at (iter-stage1)=BREAK_ITERS
    // last fail: Stage 2 fires → semantic_stall
    const totalFails = ANTI_THRASH_FAILURE_COACH_MIN + ANTI_THRASH_BREAK_ITERS + 1; // 2+3+1=6

    toolExecutorMock.executeTool.mockImplementation((name: string) =>
      name === "read_file"
        ? Promise.resolve({ success: true, output: "const x = 1;" })
        : Promise.resolve({ success: false, output: FAIL_OUTPUT }),
    );

    mocks.createChatCompletion.mockResolvedValueOnce(llmReadFile("rf-0"));
    for (let n = 0; n < totalFails; n++) {
      mocks.createChatCompletion.mockResolvedValueOnce(llmApplyPatch(`ap-${n}`, n));
    }

    const result = await runAgentLoop({
      task: "update x to 2 in src/target.ts",
      repoPath,
      mode: "patch",
      maxIterations: 20,
    });

    expect(result.terminationReason).toBe("semantic_stall");
    expect(result.success).toBe(false);
  });

  it("C5 resume-safety: coachingBudgetOverride=1 prevents Stage 1 (attempts stays at 1 < COACH_MIN=2)", async () => {
    // coachingBudgetOverride=1 → maxAttempts=1 → after first coaching round attempts stays at 1,
    // which is < ANTI_THRASH_FAILURE_COACH_MIN=2. Stage 1 never fires.
    toolExecutorMock.executeTool.mockImplementation((name: string) =>
      name === "read_file"
        ? Promise.resolve({ success: true, output: "const x = 1;" })
        : Promise.resolve({ success: false, output: FAIL_OUTPUT }),
    );

    mocks.createChatCompletion.mockResolvedValueOnce(llmReadFile("rf-0"));
    mocks.createChatCompletion.mockResolvedValueOnce(llmApplyPatch("ap-0", 0));
    mocks.createChatCompletion.mockResolvedValueOnce(llmApplyPatch("ap-1", 1));
    mocks.createChatCompletion.mockResolvedValueOnce(llmDone());

    const result = await runAgentLoop({
      task: "update x",
      repoPath,
      mode: "patch",
      maxIterations: 20,
      coachingBudgetOverride: 1,
    });

    expect(result.terminationReason).not.toBe("semantic_stall");
  });

  it("C2 disarm: write to a new file after Stage 1 grows filesModified → Stage 2 suppressed", async () => {
    // After Stage 1 fires (capturing baseline filesModified.size=1 for src/target.ts),
    // a write_file to src/other.ts grows filesModified to 2. At the Stage 2 check
    // (iter - stage1FiredAtIter >= BREAK_ITERS), filesModified.size(2) > baseline(1) → skip.
    toolExecutorMock.executeTool.mockImplementation((name: string) => {
      if (name === "read_file" || name === "write_file")
        return Promise.resolve({ success: true, output: "// ok" });
      return Promise.resolve({ success: false, output: FAIL_OUTPUT });
    });

    // Timeline (iter numbers are 0-indexed):
    // iter 0: read_file (no failure)
    // iter 1: fail (coachingAttempts→1)
    // iter 2: fail (coachingAttempts→2; 2 records with same trigger+patchHash)
    //   [pre-iter 3: Stage 1 fires, baseline=1]
    // iter 3: write_file → filesModified.size→2 (> baseline=1)
    // iter 4: fail  (Stage 2 would-be: 4-3=1 < BREAK_ITERS=3 → not yet)
    // iter 5: fail  (5-3=2 < 3 → not yet)
    // iter 6: fail  (6-3=3 >= 3, but filesModified.size=2 > baseline=1 → C2 disarms)
    // iter 7: done
    mocks.createChatCompletion.mockResolvedValueOnce(llmReadFile("rf-0"));
    for (let n = 0; n < ANTI_THRASH_FAILURE_COACH_MIN; n++) { // 2 fails → Stage 1
      mocks.createChatCompletion.mockResolvedValueOnce(llmApplyPatch(`ap-fail-${n}`, n));
    }
    mocks.createChatCompletion.mockResolvedValueOnce(llmWriteFile("wf-0")); // filesModified grows
    for (let n = 0; n < ANTI_THRASH_BREAK_ITERS; n++) { // 3 more fails → Stage 2 armed but C2 disarmed
      mocks.createChatCompletion.mockResolvedValueOnce(llmApplyPatch(`ap-fail2-${n}`, 100 + n));
    }
    mocks.createChatCompletion.mockResolvedValueOnce(llmDone());

    const result = await runAgentLoop({
      task: "update x and add other.ts",
      repoPath,
      mode: "patch",
      maxIterations: 20,
    });

    expect(result.terminationReason).not.toBe("semantic_stall");
  });

  it("de-confliction: truly identical apply_patch calls → loop_detected (not semantic_stall)", async () => {
    // Without read_file first, the no-read gate fires for each apply_patch call.
    // All calls share identical parsedArgs (no nonce) → same hashToolCall every time.
    // Loop-detector terminates at TERMINATE_THRESHOLD=4, well before Stage 2 could fire
    // (which needs COACH_MIN+BREAK_ITERS+1 = 6 iters minimum via normal path).
    toolExecutorMock.executeTool.mockResolvedValue({ success: false, output: FAIL_OUTPUT });

    // Enough responses so loop-detector fires; TERMINATE_THRESHOLD=4 (imported indirectly).
    const ENOUGH = 6;
    for (let i = 0; i < ENOUGH; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `ap-${i}`,
              type: "function",
              function: {
                name: "apply_patch",
                // NO nonce: identical parsedArgs every call → hashToolCall repeats
                arguments: JSON.stringify({ filePath: TARGET, patch: PATCH }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }

    const result = await runAgentLoop({
      task: "keep patching",
      repoPath,
      mode: "patch",
      maxIterations: 20,
    });

    expect(result.terminationReason).toBe("loop_detected");
    expect(result.terminationReason).not.toBe("semantic_stall");
  });
});

// ── P5/P6 false-positive fix (stagedWriteCount gate) ─────────────────────────

describe("agentLoop anti-thrash P5/P6 stagedWriteCount gate", () => {
  // (i) task-2 regression: multi_edit run must NOT be terminated as semantic_stall.
  // The real executeTool is used for multi_edit so that stagedWrite populates agentLoop's
  // closure stagingFiles map. The assertion drives through the real buildAntiThrashCtx →
  // ctx.stagedWriteCount=stagingFiles.size=1 → P5 returns null → no Stage-1 latch set.
  // If the staging wiring is broken (stagedWriteCount stays 0), P5 fires and the test fails
  // with a clear diagnostic — that is the intended behavior to catch a wiring regression.
  it("multi_edit writes → stagedWriteCount > 0 → P5 suppressed → run completes", async () => {
    // Create target file so the real multi_edit can find and replace content on disk.
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "target.ts"), "const x = 1;", "utf8");

    // Get the real executeTool to pass through for multi_edit so stagingFiles is populated.
    const { executeTool: realExecuteTool } =
      await vi.importActual<typeof import("../tools/toolExecutor.js")>("../tools/toolExecutor.js");

    toolExecutorMock.executeTool.mockImplementation(
      (name: string, ...rest: unknown[]) => {
        if (name === "multi_edit") {
          // Pass-through: agentLoop's closure stagingFiles is in rest[3] (opts.stagingFiles).
          // Real stagedWrite writes into that same Map, so stagingFiles.size grows to 1.
          return (realExecuteTool as (...a: unknown[]) => Promise<unknown>)(name, ...rest);
        }
        if (name === "read_file") return Promise.resolve({ success: true, output: "const x = 1;" });
        return Promise.resolve({ success: false, output: FAIL_OUTPUT });
      },
    );

    // HARNESS GOTCHA: each read_file must use a DISTINCT filePath so hashToolCall differs and
    // the loop detector (TERMINATE_THRESHOLD=4) does not pre-empt the anti-thrash machine.
    const READS_NEEDED = Math.max(ANTI_THRASH_WANDER_READ_MIN, 5);
    const ITERS_AFTER = ANTI_THRASH_WANDER_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 1;

    // Phase 1: read READS_NEEDED distinct files (builds totalReads ≥ WANDER_READ_MIN)
    for (let i = 0; i < READS_NEEDED; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce(llmReadFile(`rf-${i}`, `src/f${i}.ts`));
    }
    // Phase 2: multi_edit — real tool populates stagingFiles; stagedWriteCount becomes 1
    mocks.createChatCompletion.mockResolvedValueOnce(llmMultiEdit("me-0", ["src/target.ts"]));
    // Phase 3: more distinct reads past WANDER_ITER_MIN + BREAK_ITERS to reach Stage-2 window;
    // P5 should NOT fire Stage 1 because stagedWriteCount > 0.
    for (let i = READS_NEEDED; i < READS_NEEDED + ITERS_AFTER; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce(llmReadFile(`rf-${i}`, `src/f${i}.ts`));
    }
    mocks.createChatCompletion.mockResolvedValueOnce(llmDone());

    const result = await runAgentLoop({
      task: "refactor x to y across files",
      repoPath,
      mode: "patch",
      maxIterations: 40,
    });

    expect(
      result.terminationReason,
      "Expected no semantic_stall: if this fails, stagedWriteCount stayed 0 — check vi.importActual passthrough",
    ).not.toBe("semantic_stall");
  });

  // (ii) P5 broad-investigation exemption (f71a0c95): distinct-file reads are no longer
  // flagged as wandering. uniqueFiles=13 >= WANDER_READ_MIN=5 AND totalReads=13 < 2×13=26
  // → exemption returns null → Stage-1 never fires → run completes normally.
  it("P5 broad investigation: distinct-file reads exempt from wandering stall (post-f71a0c95)", async () => {
    toolExecutorMock.executeTool.mockImplementation((name: string) => {
      if (name === "read_file") return Promise.resolve({ success: true, output: "const x = 1;" });
      return Promise.resolve({ success: false, output: FAIL_OUTPUT });
    });

    const totalIters = ANTI_THRASH_WANDER_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2;
    for (let i = 0; i < totalIters; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce(llmReadFile(`rf-${i}`, `src/f${i}.ts`));
    }
    mocks.createChatCompletion.mockResolvedValue(llmDone()); // fallback: run ends naturally

    const result = await runAgentLoop({
      task: "investigate and fix",
      repoPath,
      mode: "patch",
      maxIterations: 40,
    });

    // Broad first-time investigation is now exempt — must NOT terminate as semantic_stall.
    expect(result.terminationReason).not.toBe("semantic_stall");
  });

  // (ii-b) P5 true-thrash lock: concentrated re-reads of few files still fire wandering.
  // uniqueFiles=2 < WANDER_READ_MIN=5 → exemption condition fails → signal fires normally.
  // Nonce _n keeps each hashToolCall unique so the loop-detector never pre-empts the stall.
  it("P5 true thrash: concentrated re-reads of few files → semantic_stall (uniqueFiles < WANDER_READ_MIN)", async () => {
    toolExecutorMock.executeTool.mockImplementation((name: string) => {
      if (name === "read_file") return Promise.resolve({ success: true, output: "const x = 1;" });
      return Promise.resolve({ success: false, output: FAIL_OUTPUT });
    });

    const FEW_FILES = ["src/alpha.ts", "src/beta.ts"] as const;
    const totalIters = ANTI_THRASH_WANDER_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2; // 13
    for (let i = 0; i < totalIters; i++) {
      const filePath = FEW_FILES[i % FEW_FILES.length]!;
      mocks.createChatCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: `rf-${i}`, type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ filePath, _n: i }) } }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }

    const result = await runAgentLoop({
      task: "investigate and fix",
      repoPath,
      mode: "patch",
      maxIterations: 40,
    });

    expect(result.terminationReason).toBe("semantic_stall");
  });

  // (iii) P6 still terminates a true cost-burner (no writes, high cost per LLM call).
  // runId is required for cost to accumulate (TokenBudgetMeter skips accounting when runId="").
  // HIGH_COST_USAGE pushes $0.10/iter; after COST_BURN_ITER_MIN=10 iters cost ≈ $1.01 > $1.
  it("P6 true stall: no writes, cost ≥ $1 → semantic_stall", async () => {
    toolExecutorMock.executeTool.mockImplementation((name: string) => {
      if (name === "read_file") return Promise.resolve({ success: true, output: "const x = 1;" });
      return Promise.resolve({ success: false, output: FAIL_OUTPUT });
    });

    const totalIters = ANTI_THRASH_COST_BURN_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2;
    for (let i = 0; i < totalIters; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce({
        ...llmReadFile(`rf-${i}`, `src/f${i}.ts`),
        usage: HIGH_COST_USAGE,
      });
    }

    const result = await runAgentLoop({
      task: "investigate and fix",
      repoPath,
      mode: "patch",
      maxIterations: 40,
      runId: "test-p6-cost-burn",
    });

    expect(result.terminationReason).toBe("semantic_stall");
  });

  // (iv) Flailing burn: no-read-blocked apply_patches with high cost → P6 semantic_stall.
  // The no-read gate at agentLoop.ts:3747 fires `continue` BEFORE executeTool and BEFORE
  // handleToolResult, so: Step 9 never runs → filesModifiedSize stays 0; stagedWrite never
  // runs → stagingFiles stays empty → stagedWriteCount stays 0. Cost still accrues per LLM
  // call. After COST_BURN_ITER_MIN iters at high cost, P6 fires. The fix's new clause is
  // INERT here (stagedWriteCount=0), confirming no false-negative was introduced.
  it("P6 flailing burn via no-read gate: all apply_patches blocked, cost accrues → semantic_stall", async () => {
    // executeTool is never reached for apply_patch (no-read gate fires first).
    toolExecutorMock.executeTool.mockResolvedValue({ success: false, output: FAIL_OUTPUT });

    const totalIters = ANTI_THRASH_COST_BURN_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2;
    for (let i = 0; i < totalIters; i++) {
      // Distinct filePaths → distinct hashToolCall → loop detector (TERMINATE_THRESHOLD=4)
      // does not pre-empt (no path is repeated 4+ times).
      mocks.createChatCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `ap-${i}`,
              type: "function",
              function: {
                name: "apply_patch",
                arguments: JSON.stringify({ filePath: `src/f${i}.ts`, patch: PATCH }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: HIGH_COST_USAGE,
      });
    }

    const result = await runAgentLoop({
      task: "keep patching distinct files",
      repoPath,
      mode: "patch",
      maxIterations: 40,
      runId: "test-p6-flail",
    });

    expect(result.terminationReason).toBe("semantic_stall");
  });
});

// ── P3 observe-only (inc-4c) ──────────────────────────────────────────────────

describe("agentLoop anti-thrash P3 observe-only (inc-4c)", () => {
  it("[zone-anti-thrash-no-progress-observed] emitted once; no stage-1 set; run completes", async () => {
    // Sequence: read_file → (run_command, apply_patch) × 5 → done
    // read_file at iter 0 satisfies the no-read gate so apply_patches can succeed.
    // Tsc baseline is captured on the first run_command (clean output); subsequent
    // run_commands introduce the same frozen error key → snapshots accumulate in the ring.
    // With ITER_MIN=8, ring has ≥2 snapshots and grows applies by iter 8 → P3 fires.
    let tscCallCount = 0;
    toolExecutorMock.executeTool.mockImplementation((toolName: string) => {
      if (toolName === "read_file") return Promise.resolve({ success: true, output: "const x = 1;" });
      if (toolName === "apply_patch") return Promise.resolve({ success: true, output: "Applied." });
      if (toolName === "run_command") {
        tscCallCount++;
        // First call: clean output → baseline = empty set (no introduced keys yet).
        if (tscCallCount === 1) return Promise.resolve({ success: true, output: "" });
        // Subsequent calls: same introduced error — frozen across iterations.
        return Promise.resolve({ success: false, output: TSC_OUTPUT_ONE_ERROR });
      }
      return Promise.resolve({ success: false, output: "" });
    });

    // iter 0: read_file (satisfies no-read gate for subsequent apply_patches)
    // iters 1-10: 5 pairs of (run_command, apply_patch) = 10 LLM calls
    // iter 11: done
    // run_command nonces keep each call unique to the loop-detector (TERMINATE_THRESHOLD=4).
    mocks.createChatCompletion.mockResolvedValueOnce(llmReadFile("rf-0"));
    for (let n = 0; n < 5; n++) {
      mocks.createChatCompletion.mockResolvedValueOnce(llmRunCommand(`rc-${n}`, "tsc --noEmit", n));
      mocks.createChatCompletion.mockResolvedValueOnce(llmApplyPatch(`ap-${n}`, n));
    }
    mocks.createChatCompletion.mockResolvedValueOnce(llmDone());

    const result = await runAgentLoop({
      task: "fix the type error in src/x.ts",
      repoPath,
      mode: "patch",
      maxIterations: 20,
    });

    // Run completes without P3 terminating it.
    expect(result.terminationReason).not.toBe("semantic_stall");
    expect(result.terminationReason).not.toBe("scope_block_circuit_breaker");

    // Observe telemetry emitted exactly once.
    const observedCalls = loggerMock.debugLog.mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("[zone-anti-thrash-no-progress-observed]"),
    );
    expect(observedCalls.length).toBe(1);

    // Stage-1 nudge was NOT set (P3 stayed out of the Stage-1/Stage-2 machine).
    const stage1Calls = loggerMock.debugLog.mock.calls.filter(
      (args: unknown[]) => String(args[0]).includes("[zone-anti-thrash-stage1]"),
    );
    expect(stage1Calls.length).toBe(0);
  });
});
