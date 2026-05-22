/**
 * Parity lock-in tests: verify handleToolResult produces identical behavior
 * to the old inline post-executeTool block in agentLoop.ts.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../subagentDispatch.js", () => ({
  handleSubagentResult: vi.fn(),
  logSubagentDispatched: vi.fn(),
}));

import { handleToolResult } from "./handleToolResult.js";
import type { ToolEventContext, HandleToolResultDeps } from "./types.js";
import { handleSubagentResult } from "../subagentDispatch.js";

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
    runId: "run-parity-1",
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
      summary: "loop",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
      loopDetected: { toolName: "run_command", count: 5 },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 0, subagentCostDelta: 0 });
});

describe("handleToolResult parity — token-budget early exit", () => {
  it("exit.success === false, terminationReason === token_budget_exceeded", async () => {
    mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 95_000, subagentCostDelta: 1.0 });
    const ctx = makeCtx();
    const deps = makeDeps();
    (deps.budget.recordSubagentResult as Mock).mockReturnValue({ ratio: 0.97 });
    const result = await handleToolResult(
      "Task",
      { prompt: "big" },
      "c1",
      { output: JSON.stringify({ filesModified: [], tokenUsage: { total: 95_000 } }), success: true },
      ctx,
      deps
    );
    expect(result.kind).toBe("early_exit");
    if (result.kind === "early_exit") {
      expect(result.exit.success).toBe(false);
      expect(result.exit.terminationReason).toBe("token_budget_exceeded");
    }
  });

  it("responseInput includes role:tool reply BEFORE synthesizeTokenBudgetExit is called", async () => {
    mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 99_000, subagentCostDelta: 0 });
    const ctx = makeCtx();
    const deps = makeDeps();
    (deps.budget.recordSubagentResult as Mock).mockReturnValue({ ratio: 0.99 });
    let messagesPassedToSynthesize: unknown[] = [];
    (deps.synthesizeTokenBudgetExit as Mock).mockImplementation(async (_iter, messages) => {
      messagesPassedToSynthesize = messages;
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
    const taskOutput = JSON.stringify({ filesModified: [], tokenUsage: { total: 99_000 } });
    await handleToolResult(
      "Task",
      { prompt: "huge" },
      "c1",
      { output: taskOutput, success: true },
      ctx,
      deps
    );
    // The messages array passed to synthesizeTokenBudgetExit must include the tool reply
    expect(messagesPassedToSynthesize).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "c1" })
    );
  });
});

describe("handleToolResult parity — loop-detected early exit", () => {
  it("exit.success === false, terminationReason === loop_detected", async () => {
    const ctx = makeCtx();
    const deps = makeDeps({
      recordAndDetect: vi.fn().mockReturnValue({ status: "terminate", count: 5 }),
    });
    const result = await handleToolResult("run_command", { cmd: "npm test" }, "c1", { output: "ok", success: true }, ctx, deps);
    expect(result.kind).toBe("early_exit");
    if (result.kind === "early_exit") {
      expect(result.exit.success).toBe(false);
      expect(result.exit.terminationReason).toBe("loop_detected");
    }
  });

  it("synthesizeLoopDetectedExit receives correct toolName", async () => {
    const ctx = makeCtx();
    const synthesize = vi.fn().mockReturnValue({
      success: false,
      terminationReason: "loop_detected",
      summary: "loop",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
      loopDetected: { toolName: "apply_patch", count: 5 },
    });
    const deps = makeDeps({
      recordAndDetect: vi.fn().mockReturnValue({ status: "terminate", count: 5 }),
      synthesizeLoopDetectedExit: synthesize,
    });
    await handleToolResult("apply_patch", { filePath: "src/foo.ts" }, "c1", { output: "ok", success: true }, ctx, deps);
    expect(synthesize).toHaveBeenCalledWith(1, "apply_patch", 5);
  });
});

describe("handleToolResult parity — failure flags before responseInput.push", () => {
  it("ordering invariant: failureDetected is true when responseInput.push is called", async () => {
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
      { output: "Error: test failed", success: false, error: "test failed" },
      ctx,
      deps
    );
    expect(failureDetectedAtPush).toBe(true);
  });
});

describe("handleToolResult parity — toolCallLog entry shape", () => {
  it("entry has {id, tool, args, result: output.slice(0,4000), success}", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const longOut = "x".repeat(5000);
    await handleToolResult(
      "run_command",
      { command: "npm test" },
      "call-abc",
      { output: longOut, success: true },
      ctx,
      deps
    );
    expect(ctx.toolCallLog).toHaveLength(1);
    expect(ctx.toolCallLog[0]).toMatchObject({
      id: "call-abc",
      tool: "run_command",
      args: { command: "npm test" },
      result: longOut.slice(0, 4000),
      success: true,
    });
  });
});

describe("handleToolResult parity — apply_patch APPLY_ROLLED_BACK rollbackCount increment", () => {
  it("increments rollbackCount when output starts with APPLY_ROLLED_BACK", async () => {
    const ctx = makeCtx({ rollbackCount: 1 });
    const deps = makeDeps();
    await handleToolResult(
      "apply_patch",
      { filePath: "src/x.ts" },
      "c1",
      { output: "APPLY_ROLLED_BACK: tests regressed", success: false },
      ctx,
      deps
    );
    expect(ctx.rollbackCount).toBe(2);
  });

  it("prevCount + 1 is the only increment — not more", async () => {
    const ctx = makeCtx({ rollbackCount: 3 });
    const deps = makeDeps();
    await handleToolResult(
      "apply_patch",
      { filePath: "src/y.ts" },
      "c1",
      { output: "APPLY_ROLLED_BACK: check failed", success: false },
      ctx,
      deps
    );
    expect(ctx.rollbackCount).toBe(4);
  });
});

describe("handleToolResult parity — read_file success path", () => {
  it("filesReadThisRun.has(filePath) after read_file success", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleToolResult("read_file", { filePath: "src/utils/helpers.ts" }, "c1", { output: "file content", success: true }, ctx, deps);
    expect(ctx.filesReadThisRun.has("src/utils/helpers.ts")).toBe(true);
  });
});

describe("handleToolResult parity — write_file path", () => {
  it("filesModified populated for write_file success", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleToolResult("write_file", { filePath: "src/new.ts" }, "c1", { output: "written", success: true }, ctx, deps);
    expect(ctx.filesModified.has("src/new.ts")).toBe(true);
  });
});

describe("handleToolResult parity — apply_patch success path", () => {
  it("filesModified populated for apply_patch success", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleToolResult("apply_patch", { filePath: "src/existing.ts" }, "c1", { output: "Patch applied", success: true }, ctx, deps);
    expect(ctx.filesModified.has("src/existing.ts")).toBe(true);
  });
});

describe("handleToolResult parity — Task success path subagent token propagation", () => {
  it("handleSubagentResult called; returned delta propagated to budget", async () => {
    mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 7500, subagentCostDelta: 0.05 });
    const ctx = makeCtx();
    const deps = makeDeps();
    (deps.budget.recordSubagentResult as Mock).mockReturnValue({ ratio: 0.3 });
    const taskOutput = JSON.stringify({ filesModified: ["src/foo.ts"], tokenUsage: { total: 7500 } });
    await handleToolResult("Task", { prompt: "do work" }, "c1", { output: taskOutput, success: true }, ctx, deps);
    expect(deps.budget.recordSubagentResult).toHaveBeenCalledWith(
      { tokens: 7500, cost: 0.05 },
      1,
      deps.onStructuredEvent
    );
  });
});

describe("handleToolResult parity — responseInput.push exactly once per non-early-exit call", () => {
  it("push called once for a normal continue result", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    const pushSpy = vi.spyOn(ctx.responseInput, "push");
    await handleToolResult("run_command", {}, "c1", { output: "ok", success: true }, ctx, deps);
    expect(pushSpy).toHaveBeenCalledOnce();
  });

  it("no double-push in token-budget early-exit path", async () => {
    mockHandleSubagentResult.mockReturnValue({ subagentTokenDelta: 96_000, subagentCostDelta: 0 });
    const ctx = makeCtx();
    const deps = makeDeps();
    (deps.budget.recordSubagentResult as Mock).mockReturnValue({ ratio: 0.97 });
    const pushSpy = vi.spyOn(ctx.responseInput, "push");
    const taskOutput = JSON.stringify({ filesModified: [], tokenUsage: { total: 96_000 } });
    await handleToolResult("Task", { prompt: "big" }, "c1", { output: taskOutput, success: true }, ctx, deps);
    // Exactly one push (the role:tool reply pushed before synthesizeTokenBudgetExit)
    expect(pushSpy).toHaveBeenCalledOnce();
  });
});
