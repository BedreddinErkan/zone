import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../subagentDispatch.js", () => ({
  handleSubagentResult: vi.fn(),
  logSubagentDispatched: vi.fn(),
}));

vi.mock("../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/logger.js")>();
  return { ...actual, debugLog: vi.fn() };
});

import { handleToolResult } from "./handleToolResult.js";
import type { ToolEventContext, HandleToolResultDeps } from "./types.js";
import type { Mock } from "vitest";
import { handleSubagentResult } from "../subagentDispatch.js";
import { debugLog } from "../../utils/logger.js";
import {
  getAndClearToolResultSummary,
  clearToolResultSizeTrackerForTest,
} from "../toolResultSizeTracker.js";

const mockHandleSubagentResult = handleSubagentResult as Mock;

function makeCtx(overrides?: Partial<ToolEventContext>): ToolEventContext {
  return {
    toolCallLog: [],
    filesModified: new Set(),
    filesReadThisRun: new Set(),
    filesReadCountThisRun: new Map(),
    failureHistory: new Map(),
    responseInput: [],
    failedFilesThisIter: new Set(),
    failureDetected: false,
    failedToolName: "",
    failedToolOutput: "",
    failedToolError: "",
    failedToolFilePath: null,
    rollbackCount: 0,
    lastLoopResult: null,
    consecutiveScopeBlocks: 0,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<HandleToolResultDeps>): HandleToolResultDeps {
  const budget = {
    recordSubagentResult: vi.fn().mockReturnValue({ ratio: 0.1 }),
    recordSubagentCostOnly: vi.fn(),
    subagentTokenTotal: 0,
    subagentCostTotal: 0,
    mainAgentTokens: 0,
    iterCostAccumulator: { total_cost: 0 } as never,
    lastIterCostPayload: null,
  };
  return {
    budget: budget as never,
    iter: 0,
    runId: "run-1",
    effectiveTokenBudgetCap: 100_000,
    tokenBudgetHardThreshold: 0.95,
    detectorState: { window: [] },
    throwIfAborted: vi.fn(),
    onStructuredEvent: vi.fn(),
    onToolResult: vi.fn(),
    synthesizeTokenBudgetExit: vi.fn().mockResolvedValue({
      success: false,
      terminationReason: "token_budget_exceeded",
      summary: "budget exceeded",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
    }),
    synthesizeLoopDetectedExit: vi.fn().mockReturnValue({
      success: false,
      terminationReason: "loop_detected",
      summary: "loop detected",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
      loopDetected: { toolName: "run_command", count: 4 },
    }),
    synthesizeScopeBlockExit: vi.fn().mockReturnValue({
      success: false,
      terminationReason: "scope_block_circuit_breaker",
      summary: "scope block circuit breaker",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
    }),
    classifyFailure: vi.fn().mockReturnValue("generic_failure"),
    extractSemanticSmellName: vi.fn().mockReturnValue("unknown"),
    extractErrorLine: vi.fn().mockReturnValue(null),
    hashPatchBlocks: vi.fn().mockReturnValue("hash-patch"),
    hashToolCall: vi.fn().mockReturnValue("hash-tool"),
    recordAndDetect: vi.fn().mockReturnValue({ status: "ok", count: 1 }),
    ...overrides,
  };
}

const SUCCESS_RESULT = { output: "ok", success: true };
const FAILURE_RESULT = { output: "Error: something failed", success: false, error: "something failed" };

describe("handleToolResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 0, subagentCostDelta: 0 });
    clearToolResultSizeTrackerForTest();
  });

  describe("normal flow", () => {
    it("returns {kind:'continue'} for a successful run_command", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      const result = await handleToolResult("run_command", {}, "call-1", SUCCESS_RESULT, ctx, deps);
      expect(result.kind).toBe("continue");
    });

    it("pushes to toolCallLog with correct shape", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      const longOutput = "x".repeat(5000);
      await handleToolResult("run_command", { cmd: "npm test" }, "call-1", { output: longOutput, success: true }, ctx, deps);
      expect(ctx.toolCallLog).toHaveLength(1);
      expect(ctx.toolCallLog[0]).toEqual({
        id: "call-1",
        tool: "run_command",
        args: { cmd: "npm test" },
        result: longOutput.slice(0, 4000),
        success: true,
      });
    });

    it("calls throwIfAborted and onToolResult early in the call", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      const order: string[] = [];
      (deps.throwIfAborted as Mock).mockImplementation(() => order.push("aborted"));
      (deps.onToolResult as Mock).mockImplementation(() => order.push("toolResult"));
      await handleToolResult("run_command", {}, "c1", SUCCESS_RESULT, ctx, deps);
      expect(order).toContain("aborted");
      expect(order).toContain("toolResult");
      expect(order.indexOf("aborted")).toBeLessThan(order.indexOf("toolResult") + 1);
    });
  });

  describe("read_file", () => {
    it("adds filePath to filesReadThisRun on success", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult("read_file", { filePath: "src/foo.ts" }, "c1", SUCCESS_RESULT, ctx, deps);
      expect(ctx.filesReadThisRun.has("src/foo.ts")).toBe(true);
    });

    it("does NOT add filePath to filesReadThisRun on failure", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult("read_file", { filePath: "src/foo.ts" }, "c1", FAILURE_RESULT, ctx, deps);
      expect(ctx.filesReadThisRun.has("src/foo.ts")).toBe(false);
    });
  });

  describe("apply_patch failure", () => {
    it("sets failure flags when apply_patch fails", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult(
        "apply_patch",
        { filePath: "src/bar.ts" },
        "c1",
        { output: "Error: patch rejected", success: false, error: "patch rejected" },
        ctx,
        deps
      );
      expect(ctx.failureDetected).toBe(true);
      expect(ctx.failedToolName).toBe("apply_patch");
      expect(ctx.failedToolOutput).toBe("Error: patch rejected");
      expect(ctx.failedToolError).toBe("patch rejected");
      expect(ctx.failedToolFilePath).toBe("src/bar.ts");
    });

    it("adds filePath to failedFilesThisIter and failureHistory on apply_patch failure", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult(
        "apply_patch",
        { filePath: "src/baz.ts" },
        "c1",
        { output: "Error: conflict", success: false },
        ctx,
        deps
      );
      expect(ctx.failedFilesThisIter.has("src/baz.ts")).toBe(true);
      expect(ctx.failureHistory.has("src/baz.ts")).toBe(true);
      const entries = ctx.failureHistory.get("src/baz.ts")!;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ iter: 1 }); // iter+1
    });
  });

  describe("apply_patch APPLY_ROLLED_BACK", () => {
    it("increments rollbackCount when output starts with APPLY_ROLLED_BACK", async () => {
      const ctx = makeCtx({ rollbackCount: 2 });
      const deps = makeDeps();
      await handleToolResult(
        "apply_patch",
        { filePath: "src/x.ts" },
        "c1",
        { output: "APPLY_ROLLED_BACK: tests regressed", success: false },
        ctx,
        deps
      );
      expect(ctx.rollbackCount).toBe(3);
    });

    it("does NOT increment rollbackCount for regular apply_patch failure", async () => {
      const ctx = makeCtx({ rollbackCount: 1 });
      const deps = makeDeps();
      await handleToolResult(
        "apply_patch",
        { filePath: "src/x.ts" },
        "c1",
        { output: "Error: file not found", success: false },
        ctx,
        deps
      );
      expect(ctx.rollbackCount).toBe(1);
    });
  });

  describe("filesModified", () => {
    it("adds filePath to filesModified for write_file success", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult("write_file", { filePath: "src/new.ts" }, "c1", SUCCESS_RESULT, ctx, deps);
      expect(ctx.filesModified.has("src/new.ts")).toBe(true);
    });

    it("adds filePath to filesModified for apply_patch success", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult("apply_patch", { filePath: "src/existing.ts" }, "c1", SUCCESS_RESULT, ctx, deps);
      expect(ctx.filesModified.has("src/existing.ts")).toBe(true);
    });
  });

  describe("Task tool", () => {
    it("returns {kind:'continue'} when subagent token ratio stays below threshold", async () => {
      mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 5000, subagentCostDelta: 0.01 });
      const ctx = makeCtx();
      const deps = makeDeps();
      (deps.budget.recordSubagentResult as Mock).mockReturnValue({ ratio: 0.5 });
      const result = await handleToolResult(
        "Task",
        { prompt: "do something" },
        "c1",
        { output: JSON.stringify({ filesModified: [], tokenUsage: { total: 5000 } }), success: true },
        ctx,
        deps
      );
      expect(result.kind).toBe("continue");
    });

    it("returns {kind:'early_exit'} when subagent token ratio exceeds hard threshold", async () => {
      mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 95_000, subagentCostDelta: 1.0 });
      const ctx = makeCtx();
      const deps = makeDeps();
      (deps.budget.recordSubagentResult as Mock).mockReturnValue({ ratio: 0.97 });
      const result = await handleToolResult(
        "Task",
        { prompt: "big task" },
        "c1",
        { output: JSON.stringify({ filesModified: [], tokenUsage: { total: 95_000 } }), success: true },
        ctx,
        deps
      );
      expect(result.kind).toBe("early_exit");
      if (result.kind === "early_exit") {
        expect(result.exit.terminationReason).toBe("token_budget_exceeded");
      }
    });

    it("calls recordSubagentCostOnly (not recordSubagentResult) when subagentTokenDelta is 0", async () => {
      mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 0, subagentCostDelta: 0.05 });
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult(
        "Task",
        { prompt: "zero tokens" },
        "c1",
        { output: JSON.stringify({ filesModified: [] }), success: true },
        ctx,
        deps
      );
      expect(deps.budget.recordSubagentCostOnly).toHaveBeenCalledWith(0.05);
      expect(deps.budget.recordSubagentResult).not.toHaveBeenCalled();
    });

    it("does NOT set failureDetected for a failed Task result (parent failure machinery stays dormant)", async () => {
      // A failed subagent returns success:false after Inc B. The parent should NOT
      // coach/retry — the model already sees the JSON status:"failed" at Step 11.
      mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 0, subagentCostDelta: 0 });
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult(
        "Task",
        { prompt: "do work" },
        "c1",
        { output: JSON.stringify({ status: "failed", summary: "Worker failed." }), success: false },
        ctx,
        deps
      );
      expect(ctx.failureDetected).toBe(false);
      expect(ctx.failedToolName).toBe("");
    });
  });

  describe("loop detector", () => {
    it("returns {kind:'early_exit'} when recordAndDetect returns terminate", async () => {
      const ctx = makeCtx();
      const deps = makeDeps({
        recordAndDetect: vi.fn().mockReturnValue({ status: "terminate", count: 4 }),
      });
      const result = await handleToolResult("run_command", { cmd: "npm test" }, "c1", SUCCESS_RESULT, ctx, deps);
      expect(result.kind).toBe("early_exit");
      if (result.kind === "early_exit") {
        expect(result.exit.terminationReason).toBe("loop_detected");
      }
    });

    it("emits loop_detected_terminal SSE event on terminate", async () => {
      const ctx = makeCtx();
      const onStructuredEvent = vi.fn();
      const deps = makeDeps({
        recordAndDetect: vi.fn().mockReturnValue({ status: "terminate", count: 4 }),
        onStructuredEvent,
      });
      await handleToolResult("run_command", {}, "c1", SUCCESS_RESULT, ctx, deps);
      expect(onStructuredEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "loop_detected_terminal" })
      );
    });

    it("returns {kind:'continue'} when recordAndDetect returns ok", async () => {
      const ctx = makeCtx();
      const deps = makeDeps({
        recordAndDetect: vi.fn().mockReturnValue({ status: "ok", count: 1 }),
      });
      const result = await handleToolResult("run_command", {}, "c1", SUCCESS_RESULT, ctx, deps);
      expect(result.kind).toBe("continue");
    });
  });

  describe("ordering invariant", () => {
    it("failure flags set BEFORE responseInput.push", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      let failureDetectedAtPush = false;
      const origPush = ctx.responseInput.push.bind(ctx.responseInput);
      ctx.responseInput.push = (...args) => {
        failureDetectedAtPush = ctx.failureDetected;
        return origPush(...args);
      };
      await handleToolResult(
        "run_command",
        {},
        "c1",
        FAILURE_RESULT,
        ctx,
        deps
      );
      expect(failureDetectedAtPush).toBe(true);
    });

    it("responseInput.push called exactly once per non-early-exit call", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      const pushSpy = vi.spyOn(ctx.responseInput, "push");
      await handleToolResult("run_command", {}, "c1", SUCCESS_RESULT, ctx, deps);
      expect(pushSpy).toHaveBeenCalledOnce();
    });

    it("early_exit from token budget: responseInput push happens before exit (for tool reply)", async () => {
      mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 95_000, subagentCostDelta: 0 });
      const ctx = makeCtx();
      const deps = makeDeps();
      (deps.budget.recordSubagentResult as Mock).mockReturnValue({ ratio: 0.99 });
      let responseInputLenAtSynthesize = -1;
      (deps.synthesizeTokenBudgetExit as Mock).mockImplementation(async (_iter, messages) => {
        responseInputLenAtSynthesize = messages.length;
        return {
          success: false,
          terminationReason: "token_budget_exceeded",
          summary: "budget",
          toolCallLog: [],
          filesModified: [],
          patchValidatedByAgent: false,
          verificationReason: "no_verification_attempted",
        };
      });
      await handleToolResult(
        "Task",
        { prompt: "big" },
        "c1",
        { output: JSON.stringify({ filesModified: [], tokenUsage: { total: 95_000 } }), success: true },
        ctx,
        deps
      );
      // synthesizeTokenBudgetExit receives messages that include the tool reply
      expect(responseInputLenAtSynthesize).toBeGreaterThan(0);
    });
  });

  describe("tool result size telemetry", () => {
    afterEach(() => clearToolResultSizeTrackerForTest());

    it("records byte size in tracker for a successful tool result push", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      const output = "hello world";
      await handleToolResult("run_command", {}, "cid1", { output, success: true }, ctx, deps);
      const s = getAndClearToolResultSummary(deps.runId ?? "anon")!;
      expect(s).not.toBeNull();
      expect(s.totalResults).toBe(1);
      expect(s.perTool["run_command"]).toBeDefined();
      expect(s.perTool["run_command"].bytes).toBe(Buffer.byteLength(output, "utf8"));
    });
  });

  describe("scope-block circuit breaker", () => {
    const SCOPE_BLOCK_APPLY = {
      output: 'Write blocked: "src/store.tsx" is outside the planned scope.',
      success: false,
      error: "apply_patch_blocked_out_of_plan_scope",
    };
    const SCOPE_BLOCK_WRITE = {
      output: 'Write blocked: "src/store.tsx" is outside the planned scope.',
      success: false,
      error: "write_file_blocked_out_of_plan_scope",
    };
    const WRITE_SUCCESS = { output: "Patch applied: 1 block(s)", success: true };

    it("does not terminate before 5 consecutive scope blocks", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      for (let i = 0; i < 4; i++) {
        const result = await handleToolResult(
          "apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx, deps
        );
        expect(result.kind).toBe("continue");
      }
      expect(ctx.consecutiveScopeBlocks).toBe(4);
    });

    it("appends coaching nudge to the last responseInput entry at the 3rd block", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      for (let i = 0; i < 3; i++) {
        await handleToolResult(
          "apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx, deps
        );
      }
      const last = ctx.responseInput[ctx.responseInput.length - 1];
      expect(last?.role).toBe("tool");
      expect(typeof last?.content).toBe("string");
      expect((last?.content as string)).toContain("SCOPE-BLOCK COACHING");
      expect((last?.content as string)).toContain("extension mismatch");
    });

    it("returns early_exit with scope_block_circuit_breaker at 5 consecutive blocks", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      let result: Awaited<ReturnType<typeof handleToolResult>> = { kind: "continue" };
      for (let i = 0; i < 5; i++) {
        result = await handleToolResult(
          "apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx, deps
        );
      }
      expect(result.kind).toBe("early_exit");
      if (result.kind === "early_exit") {
        expect(result.exit.terminationReason).toBe("scope_block_circuit_breaker");
      }
      expect(deps.synthesizeScopeBlockExit).toHaveBeenCalledOnce();
    });

    it("write_file scope block counts the same as apply_patch scope block", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      let result: Awaited<ReturnType<typeof handleToolResult>> = { kind: "continue" };
      for (let i = 0; i < 5; i++) {
        result = await handleToolResult(
          "write_file", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_WRITE, ctx, deps
        );
      }
      expect(result.kind).toBe("early_exit");
      if (result.kind === "early_exit") {
        expect(result.exit.terminationReason).toBe("scope_block_circuit_breaker");
      }
    });

    it("resets counter to 0 on a successful write, preventing premature termination", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      // 4 blocks, then a success, then 4 more — never reaches 5 consecutive
      for (let i = 0; i < 4; i++) {
        await handleToolResult("apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx, deps);
      }
      expect(ctx.consecutiveScopeBlocks).toBe(4);
      await handleToolResult("apply_patch", { filePath: "src/ok.ts" }, "ok", WRITE_SUCCESS, ctx, deps);
      expect(ctx.consecutiveScopeBlocks).toBe(0);
      for (let i = 0; i < 4; i++) {
        const r = await handleToolResult("apply_patch", { filePath: "src/store.tsx" }, `d${i}`, SCOPE_BLOCK_APPLY, ctx, deps);
        expect(r.kind).toBe("continue");
      }
      expect(ctx.consecutiveScopeBlocks).toBe(4);
    });

    it("emits scope_block_circuit_terminal structured event at terminate", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      for (let i = 0; i < 5; i++) {
        await handleToolResult("apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx, deps);
      }
      const eventCalls = (deps.onStructuredEvent as ReturnType<typeof vi.fn>).mock.calls;
      const terminalEvent = eventCalls.map((c: unknown[]) => c[0]).find(
        (e: unknown) => (e as { type?: string }).type === "scope_block_circuit_terminal"
      );
      expect(terminalEvent).toBeDefined();
      expect((terminalEvent as { blockedCount?: number }).blockedCount).toBe(5);
    });

    it("emits [zone-replan-trigger-observed] debugLog at exactly the 3rd block, not before", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      const mockDebugLog = debugLog as Mock;

      // 2 blocks — marker must NOT have fired
      for (let i = 0; i < 2; i++) {
        await handleToolResult("apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx, deps);
      }
      const markerCallsBefore = mockDebugLog.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("zone-replan-trigger-observed")
      );
      expect(markerCallsBefore).toHaveLength(0);

      // 3rd block — marker must fire exactly once
      await handleToolResult("apply_patch", { filePath: "src/store.tsx" }, "c2", SCOPE_BLOCK_APPLY, ctx, deps);
      const markerCallsAfter = mockDebugLog.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("zone-replan-trigger-observed")
      );
      expect(markerCallsAfter).toHaveLength(1);

      // Payload fields
      const payload = JSON.parse(markerCallsAfter[0]![1] as string) as Record<string, unknown>;
      expect(payload.blockCount).toBe(3);
      expect(payload.iter).toBe(1); // deps.iter=0, so iter+1=1
      expect(payload.toolName).toBe("apply_patch");
      expect(payload.runId).toBe("run-1");
    });

    it("fires across iteration boundary: 4 blocks in iter N + 1 block in iter N+1 = early_exit", async () => {
      // Simulate iter N: 4 blocks accumulate
      const ctx1 = makeCtx();
      const deps = makeDeps();
      for (let i = 0; i < 4; i++) {
        const r = await handleToolResult(
          "apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx1, deps
        );
        expect(r.kind).toBe("continue");
      }
      expect(ctx1.consecutiveScopeBlocks).toBe(4);

      // Simulate iter N+1: new toolEventCtx seeded from outer var (mirrors the agentLoop writeback fix)
      const ctx2 = makeCtx();
      ctx2.consecutiveScopeBlocks = ctx1.consecutiveScopeBlocks;
      const result = await handleToolResult(
        "apply_patch", { filePath: "src/store.tsx" }, "c4", SCOPE_BLOCK_APPLY, ctx2, deps
      );
      expect(result.kind).toBe("early_exit");
      if (result.kind === "early_exit") {
        expect(result.exit.terminationReason).toBe("scope_block_circuit_breaker");
      }
    });

    it("ZONE_PLAN_REPLAN=1 + 3rd block + replanState.count=0 → replan_signal, nudge NOT appended", async () => {
      const ctx = makeCtx();
      const deps = makeDeps({ replanEnabled: true, replanState: { count: 0 } });
      let result: Awaited<ReturnType<typeof handleToolResult>> = { kind: "continue" };
      for (let i = 0; i < 3; i++) {
        result = await handleToolResult(
          "apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx, deps
        );
      }
      expect(result.kind).toBe("replan_signal");
      if (result.kind === "replan_signal") {
        expect(result.blockedPath).toBe("src/store.tsx");
      }
      // The nudge text must NOT have been appended — the replan_signal returned early
      const nudgedEntry = ctx.responseInput.find(
        (m) => typeof m.content === "string" && (m.content as string).includes("SCOPE-BLOCK COACHING")
      );
      expect(nudgedEntry).toBeUndefined();
      // But the observe marker still fires
      const mockDebugLog = debugLog as Mock;
      const observeCalls = mockDebugLog.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("zone-replan-trigger-observed")
      );
      expect(observeCalls).toHaveLength(1);
    });

    it("ZONE_PLAN_REPLAN=1 + 3rd block + replanState.count=1 → one-shot guard: nudge as normal, no replan_signal", async () => {
      const ctx = makeCtx();
      const deps = makeDeps({ replanEnabled: true, replanState: { count: 1 } });
      let result: Awaited<ReturnType<typeof handleToolResult>> = { kind: "continue" };
      for (let i = 0; i < 3; i++) {
        result = await handleToolResult(
          "apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx, deps
        );
      }
      expect(result.kind).toBe("continue");
      const last = ctx.responseInput[ctx.responseInput.length - 1];
      expect((last?.content as string)).toContain("SCOPE-BLOCK COACHING");
    });

    it("ZONE_PLAN_REPLAN not set → flag-off behavior: nudge at 3, early_exit at 5 (regression)", async () => {
      const ctx = makeCtx();
      const deps = makeDeps({ replanEnabled: false });
      let result: Awaited<ReturnType<typeof handleToolResult>> = { kind: "continue" };
      for (let i = 0; i < 3; i++) {
        result = await handleToolResult(
          "apply_patch", { filePath: "src/store.tsx" }, `c${i}`, SCOPE_BLOCK_APPLY, ctx, deps
        );
      }
      // 3rd block: nudge, not replan_signal
      expect(result.kind).toBe("continue");
      const last3 = ctx.responseInput[ctx.responseInput.length - 1];
      expect((last3?.content as string)).toContain("SCOPE-BLOCK COACHING");
      // 4th block: continue
      result = await handleToolResult(
        "apply_patch", { filePath: "src/store.tsx" }, "c3", SCOPE_BLOCK_APPLY, ctx, deps
      );
      expect(result.kind).toBe("continue");
      // 5th block: early_exit
      result = await handleToolResult(
        "apply_patch", { filePath: "src/store.tsx" }, "c4", SCOPE_BLOCK_APPLY, ctx, deps
      );
      expect(result.kind).toBe("early_exit");
      if (result.kind === "early_exit") {
        expect(result.exit.terminationReason).toBe("scope_block_circuit_breaker");
      }
    });
  });

  describe("DF-18: loop detection exemption for read_background_output", () => {
    it("does NOT call recordAndDetect for read_background_output", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult("read_background_output", { handle: "bg1", since_offset: null, max_bytes: 8192 }, "c1", SUCCESS_RESULT, ctx, deps);
      expect(deps.recordAndDetect).not.toHaveBeenCalled();
      expect(ctx.lastLoopResult).toBeNull();
    });

    it("DOES call recordAndDetect for read_file (not exempt)", async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      await handleToolResult("read_file", { filePath: "src/foo.ts" }, "c1", SUCCESS_RESULT, ctx, deps);
      expect(deps.recordAndDetect).toHaveBeenCalled();
    });

    it("4 identical read_background_output calls all return {kind:'continue'} (no early_exit)", async () => {
      const { recordAndDetect: realRecordAndDetect, createDetectorState: realCreateDetectorState } =
        await import("../loopDetector.js");
      const state = realCreateDetectorState();
      const ctx = makeCtx();
      const deps = makeDeps({
        recordAndDetect: (s, h) => realRecordAndDetect(s, h),
        detectorState: state,
      });
      const args = { handle: "bg1", since_offset: null, max_bytes: 8192 };
      for (let i = 0; i < 4; i++) {
        const result = await handleToolResult("read_background_output", args, `c${i}`, SUCCESS_RESULT, ctx, deps);
        expect(result.kind, `call ${i + 1} should continue`).toBe("continue");
      }
    });
  });
});
