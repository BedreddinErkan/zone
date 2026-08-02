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
    // Item 14: a mocked write_file success must carry filesStaged itself now — Step 9 no
    // longer infers a mutation from result.success alone, matching what a real successful
    // write_file call returns (toolExecutor.ts's return #10).
    toolExecutorMock.executeTool.mockImplementation((name: string) => {
      if (name === "read_file") return Promise.resolve({ success: true, output: "// ok" });
      if (name === "write_file") return Promise.resolve({ success: true, output: "// ok", filesStaged: [OTHER] });
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

// ── Characterization: item 14's Step 9 fix, confirmed ──────────────────────────
//
// handleToolResult.ts's Step 9 now reads result.filesStaged uniformly for every write
// tool (apply_patch/write_file/multi_edit), instead of adding a write attempt's filePath
// to filesModified unconditionally regardless of result.success. These tests pin what
// P5/P6 and Stage-2 C2 do now because of that.
//
// The two stale comments this fix corrects (both now rewritten, not left open):
//   - agentLoop.ts, inside buildAntiThrashCtx: no longer claims Step 9 fires
//     unconditionally on any executed apply_patch/write_file call.
//   - antiThrash.ts, AntiThrashContext.stagedWriteCount's own doc: no longer implies
//     stagedWriteCount>0 in a P5/P6 context means multi_edit — an apply_patch/write_file
//     rollback (test 11b below) reaches that same state too, attributable to itself.
describe("characterization: Step 9's filesStaged-gated filesModified (item 14)", () => {
  // 11a was originally one test with both assertions below. Under the gate-as-mutation
  // (mutation (a) in this task's report), it failed at the first assertion and execution
  // stopped there, so the second — the direct evidence for the write_file-new-file subset
  // the gate actually changes — was predicted, never measured. Split so both are
  // independently observable, each alone, same fixture/mock setup duplicated verbatim.
  it("11a-i: failed new-file write_file no longer suppresses P6 (cost_burn) — terminationReason", async () => {
    const NEW_FILE = "src/brand-new.ts";

    toolExecutorMock.executeTool.mockImplementation((name: string) => {
      if (name === "write_file") {
        return Promise.resolve({ success: false, output: "write_file_blocked: could not create file" });
      }
      if (name === "read_file") return Promise.resolve({ success: true, output: "const x = 1;" });
      return Promise.resolve({ success: false, output: FAIL_OUTPUT });
    });

    const totalIters = ANTI_THRASH_COST_BURN_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2; // 15

    // iter 0: FAILED write_file to a brand-new file. handleToolResult.ts Step 9 (real,
    // ungated today) unconditionally adds NEW_FILE to ctx.filesModified even though
    // result.success is false.
    mocks.createChatCompletion.mockResolvedValueOnce({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "wf-fail-0",
            type: "function",
            function: { name: "write_file", arguments: JSON.stringify({ filePath: NEW_FILE, content: "const y = 1;" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: HIGH_COST_USAGE,
    });
    // iters 1..totalIters-1: high-cost reads on distinct files — mirrors the file's own
    // "(iii) P6 true stall" test's cost/iter shape exactly.
    for (let i = 1; i < totalIters; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce({
        ...llmReadFile(`rf-${i}`, `src/f${i}.ts`),
        usage: HIGH_COST_USAGE,
      });
    }
    mocks.createChatCompletion.mockResolvedValue(llmDone()); // fallback: run ends naturally

    const result = await runAgentLoop({
      task: "investigate and fix",
      repoPath,
      mode: "patch",
      maxIterations: 40,
      runId: "test-11a-i-write-fail-cost-burn",
    });

    // POST-FIX: the mock write_file failure never sets filesStaged, so Step 9 adds
    // nothing — filesModifiedSize stays 0 for the whole run (nothing else in this
    // fixture writes either). P6's guard (antiThrash.ts:129) no longer holds, so P6
    // fires once the cost/iter thresholds are crossed, exactly as the file's own
    // "(iii) P6 true stall" test does.
    expect(result.terminationReason).toBe("semantic_stall");
  });

  it("11a-ii: failed new-file write_file no longer pollutes filesModified", async () => {
    const NEW_FILE = "src/brand-new.ts";

    toolExecutorMock.executeTool.mockImplementation((name: string) => {
      if (name === "write_file") {
        return Promise.resolve({ success: false, output: "write_file_blocked: could not create file" });
      }
      if (name === "read_file") return Promise.resolve({ success: true, output: "const x = 1;" });
      return Promise.resolve({ success: false, output: FAIL_OUTPUT });
    });

    const totalIters = ANTI_THRASH_COST_BURN_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2; // 15

    mocks.createChatCompletion.mockResolvedValueOnce({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "wf-fail-0",
            type: "function",
            function: { name: "write_file", arguments: JSON.stringify({ filePath: NEW_FILE, content: "const y = 1;" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: HIGH_COST_USAGE,
    });
    for (let i = 1; i < totalIters; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce({
        ...llmReadFile(`rf-${i}`, `src/f${i}.ts`),
        usage: HIGH_COST_USAGE,
      });
    }
    mocks.createChatCompletion.mockResolvedValue(llmDone());

    const result = await runAgentLoop({
      task: "investigate and fix",
      repoPath,
      mode: "patch",
      maxIterations: 40,
      runId: "test-11a-ii-write-fail-cost-burn",
    });

    // POST-FIX: direct read of Step 9's own output. The mock write_file failure never
    // sets filesStaged, so `for (const p of result.filesStaged ?? []) ...` adds nothing
    // for this call — filesModified stays empty.
    expect(result.filesModified).toEqual([]);
  });

  it("11b: failed apply_patch (real post-write rollback) suppresses P6 via stagedWriteCount alone now", async () => {
    const TARGET_JS = "src/target.js";
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "target.js"), "const x = 1;", "utf8");

    // Real passthrough for apply_patch only (mirrors the file's own multi_edit
    // real-passthrough test above). .js (not .ts) is load-bearing: findCheckerForFile has
    // no entry for .js, so toolExecutor's W.1 inline-tsc-check block takes its
    // `if (!checker)` branch (toolExecutor.ts:2490) synchronously — zero subprocess,
    // regardless of whether tsc/npx are resolvable on the test machine. The POST-write
    // validateSyntax check we DO want (toolExecutor.ts:2618) is a pure in-process
    // @babel/parser call either way.
    const { executeTool: realExecuteTool } =
      await vi.importActual<typeof import("../tools/toolExecutor.js")>("../tools/toolExecutor.js");

    toolExecutorMock.executeTool.mockImplementation(
      (name: string, ...rest: unknown[]) => {
        if (name === "apply_patch") {
          return (realExecuteTool as (...a: unknown[]) => Promise<unknown>)(name, ...rest);
        }
        if (name === "read_file") return Promise.resolve({ success: true, output: "const x = 1;" });
        return Promise.resolve({ success: false, output: FAIL_OUTPUT });
      },
    );

    const totalIters = ANTI_THRASH_COST_BURN_ITER_MIN + ANTI_THRASH_BREAK_ITERS + 2; // 15

    // iter 0: read_file(TARGET_JS) — required so the real apply_patch passes the
    // read-before-patch gate (agentLoop.ts's own pre-check AND toolExecutor's internal
    // input.filesReadThisRun check both key off this exact path string).
    mocks.createChatCompletion.mockResolvedValueOnce({
      ...llmReadFile("rf-setup", TARGET_JS),
      usage: HIGH_COST_USAGE,
    });
    // iter 1: REAL apply_patch. FIND matches the fixture verbatim; REPLACE appends an
    // unterminated `function broken(` that @babel/parser cannot parse — lands on the
    // POST-write syntax-broken rollback (toolExecutor.ts:2638-2652), which calls the
    // real stagedWrite(input?.stagingFiles, abs, original) at :2640, leaving TARGET_JS's
    // key in the SAME stagingFiles Map agentLoop's closure holds (opts.stagingFiles,
    // agentLoop.ts:4852).
    mocks.createChatCompletion.mockResolvedValueOnce({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "ap-rollback-0",
            type: "function",
            function: {
              name: "apply_patch",
              arguments: JSON.stringify({
                filePath: TARGET_JS,
                patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 1;\nfunction broken(",
              }),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: HIGH_COST_USAGE,
    });
    // iters 2..totalIters-1 (13 calls): high-cost reads on distinct files. Combined with
    // the 2 calls above: 15 total HIGH_COST_USAGE calls — identical count/per-call cost
    // to 11a's [1 write-attempt + 14 reads], so both cross the cost/iter thresholds at
    // the same cumulative point. Not a byte-for-byte minimal pair: apply_patch's
    // read-before-patch precondition has no write_file analog, so this test's first call
    // does double duty as both a precondition-satisfying read and a threshold contributor.
    for (let i = 2; i < totalIters; i++) {
      mocks.createChatCompletion.mockResolvedValueOnce({
        ...llmReadFile(`rf-${i}`, `src/f${i}.ts`),
        usage: HIGH_COST_USAGE,
      });
    }
    mocks.createChatCompletion.mockResolvedValue(llmDone());

    const result = await runAgentLoop({
      task: "investigate and fix",
      repoPath,
      mode: "patch",
      maxIterations: 40,
      runId: "test-11b-apply-patch-rollback-cost-burn",
    });

    // POST-FIX: stagingFiles.size stays 1 — the real rollback's
    // stagedWrite(input?.stagingFiles, abs, original) call (toolExecutor.ts's
    // post-write-syntax-broken branch) still writes into stagingFiles regardless of
    // whether the return carries filesStaged, so stagedWriteCount alone continues to
    // suppress P5/P6 here.
    expect(result.terminationReason).not.toBe("semantic_stall");
    // POST-FIX: flipped to []. The real rollback return carries no filesStaged (content
    // was restored to its pre-call state, not persisted — toolExecutor.ts's rollback
    // returns are deliberately bare), so Step 9 adds nothing.
    expect(result.filesModified).toEqual([]);
  });

  it("12: Stage-2's baseline (captured at Stage-1 fire) no longer includes a failed apply_patch's path", async () => {
    // Structurally this is the file's own "P4 terminal" test (line 184) — the minimal
    // shape where Stage 1 fires via P4 (failure_stall, independent of filesModifiedSize)
    // and filesModified never grows after baseline capture, so filesModified's LIVE
    // contents at the eventual stall exit are byte-identical to what
    // antiThrashFilesModifiedAtStage1 (agentLoop.ts:3735) measured at capture time —
    // verified empirically, see this task's build notes, not just argued here.
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
    mocks.createChatCompletion.mockResolvedValue(llmDone()); // safety net only — under normal
    // execution the run terminates via Stage 2 well within the 7 queued responses above, so
    // this is never reached; it activates only when a mutation delays termination (as the
    // baseline-hardcoded-to-0 mutation does), turning a mock-queue-exhaustion crash into a
    // clean, readable assertion result. The pre-existing "P4 terminal" test (line 184) this
    // test structurally mirrors has the identical no-fallback shape and remains crash-prone
    // under the same class of mutation — deliberately not touched here.

    const result = await runAgentLoop({
      task: "update x to 2 in src/target.ts",
      repoPath,
      mode: "patch",
      maxIterations: 20,
    });

    // POST-FIX: unchanged. Stage-1 fires via P4 (failure_stall), which never consults
    // filesModifiedSize/stagedWriteCount, so it fires identically either way. Stage 2's
    // C2 comparison (filesModified.size <= antiThrashFilesModifiedAtStage1) now holds at
    // 0 <= 0 instead of 1 <= 1 — both sides moved together, C2 still holds.
    expect(result.terminationReason).toBe("semantic_stall");
    // POST-FIX: flipped to []. Every apply_patch on TARGET failed before ever reaching
    // toolExecutor's write-commit point (these mocked failures never call stagedWrite),
    // so filesStaged was never set and Step 9 adds nothing — filesModified, and the
    // Stage-1 baseline snapshot taken from it, both stay empty.
    expect(result.filesModified).toEqual([]);
  });
});
