/**
 * Inc-2 integration tests: adaptive replan on scope-block divergence.
 *
 * When ZONE_PLAN_REPLAN=1 and 3 consecutive write attempts are blocked by
 * the plan scope guard, agentLoop calls generateExecutionPlan to regenerate
 * the remaining steps and swaps the live plan. The one-shot guard prevents
 * a second replan in the same run.
 *
 * Strategy: mock the LLM factory (no real API calls), mock toolExecutor to
 * return scope-block errors for apply_patch, mock generateExecutionPlan, then
 * assert behavioral outcomes.
 *
 * Key constraint: agentLoop has a C1 pre-exec check that fires for apply_patch
 * on files that have not been read or written yet this run (wasFileReadOrWritten).
 * If C1 fires, handleToolResult is skipped entirely (continue) — so
 * consecutiveScopeBlocks never increments. Each test must seed a read_file
 * before the blocked apply_patch calls.
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

const llmMock = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

const replanMock = vi.hoisted(() => vi.fn());

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: llmMock.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("./executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./executionPlan.js")>();
  return { ...actual, generateExecutionPlan: replanMock };
});

// ── import under test ─────────────────────────────────────────────────────────

import { runAgentLoop } from "./agentLoop.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const BLOCKED_FILE = "src/target.ts";

function makeToolCallResponse(id: string, toolName: string, args: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: {
            name: toolName,
            arguments: JSON.stringify(args),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeReadFileResponse(id: string, filePath = BLOCKED_FILE) {
  return makeToolCallResponse(id, "read_file", { filePath });
}

function makeScopeBlockResponse(id: string, filePath = BLOCKED_FILE) {
  return makeToolCallResponse(id, "apply_patch", {
    filePath,
    patch: "--- FIND ---\nold\n--- REPLACE ---\nnew",
  });
}

function makeWriteFileResponse(id: string, filePath: string) {
  return makeToolCallResponse(id, "write_file", { filePath, content: "// done" });
}

function makeDoneResponse(text = "Task complete.") {
  return {
    choices: [{
      message: { content: text, tool_calls: null },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const SCOPE_BLOCK_RESULT = {
  success: false,
  output: `Write blocked: "${BLOCKED_FILE}" is outside the planned scope.`,
  error: "apply_patch_blocked_out_of_plan_scope",
};

const READ_SUCCESS_RESULT = { success: true, output: "// file content" };
const WRITE_SUCCESS_RESULT = { success: true, output: "Written: 1 file(s)" };

function makeNewPlan(files: string[] = [BLOCKED_FILE]) {
  return {
    objective: "Revised objective — includes the blocked file",
    steps: [{
      title: "Edit target",
      description: "Apply the required change",
      filesLikely: [...files],
    }],
    riskHints: [],
    scopeSummary: "updated scope",
  };
}

function makeInitialPlan(files: string[] = []) {
  return {
    objective: "Initial objective",
    steps: [{
      title: "Step 1",
      description: "Make changes",
      filesLikely: [...files],
    }],
    riskHints: [],
    scopeSummary: "original scope",
  };
}

// ── fixture ───────────────────────────────────────────────────────────────────

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-replan-"));
  resetToolExecutorMock(toolExecutorMock);
  vi.clearAllMocks();
  // executeTool: distinguish read_file (success) vs apply_patch (scope-block) vs others
  toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
    if (name === "read_file") return READ_SUCCESS_RESULT;
    if (name === "write_file") return WRITE_SUCCESS_RESULT;
    return SCOPE_BLOCK_RESULT;
  });
  replanMock.mockResolvedValue(makeNewPlan());
  process.env["ZONE_PLAN_REPLAN"] = "1";
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
  delete process.env["ZONE_PLAN_REPLAN"];
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("agentLoop adaptive replan (Inc-2)", () => {
  it("calls generateExecutionPlan once after 3 consecutive scope-blocks", async () => {
    // Sequence: read_file (clears C1 gate) → 3× apply_patch blocked → done
    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeReadFileResponse("rf-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-1"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-2"))
      .mockResolvedValueOnce(makeDoneResponse());

    await runAgentLoop({
      task: "edit src/target.ts",
      repoPath,
      mode: "patch",
      maxIterations: 20,
      executionPlan: makeInitialPlan(["src/other.ts"]),
    });

    expect(replanMock).toHaveBeenCalledTimes(1);
    const call = replanMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["task"]).toBe("edit src/target.ts");
    expect((call["userFeedback"] as string)).toContain(BLOCKED_FILE);
    expect(call["previousPlan"]).toBeDefined();
  });

  it("emits todo_revised structured event after successful replan", async () => {
    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeReadFileResponse("rf-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-1"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-2"))
      .mockResolvedValueOnce(makeDoneResponse());

    const events: unknown[] = [];
    await runAgentLoop({
      task: "edit src/target.ts",
      repoPath,
      mode: "patch",
      maxIterations: 20,
      executionPlan: makeInitialPlan(["src/other.ts"]),
      onStructuredEvent: (e) => events.push(e),
    });

    expect(replanMock).toHaveBeenCalledTimes(1);
    const todoRevisedEvent = events.find(
      (e) => (e as { type?: string }).type === "todo_revised"
    );
    expect(todoRevisedEvent).toBeDefined();
  });

  it("one-shot guard: generateExecutionPlan called only ONCE even after 6 blocked calls", async () => {
    // read_file clears C1 → 6 blocks → done
    // After 3 blocks, replan fires (count→1). After reset, 3 more blocks hit nudge or loop detector
    // (not replan — one-shot guard prevents it). We verify replanMock was called exactly once.
    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeReadFileResponse("rf-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-1"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-2"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-3"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-4"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-5"))
      .mockResolvedValueOnce(makeDoneResponse());

    await runAgentLoop({
      task: "edit src/target.ts",
      repoPath,
      mode: "patch",
      maxIterations: 20,
      executionPlan: makeInitialPlan(["src/other.ts"]),
    });

    expect(replanMock).toHaveBeenCalledTimes(1);
  });

  it("mid-edit safety: already-modified file added to userFeedback when new plan omits it", async () => {
    // write_file("src/already-done.ts") succeeds → read_file("src/target.ts") → 3 blocked → done
    // filesModified will contain "src/already-done.ts"; new plan only lists "src/target.ts"
    // userFeedback should mention "src/already-done.ts" as already modified
    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeWriteFileResponse("wf-0", "src/already-done.ts"))
      .mockResolvedValueOnce(makeReadFileResponse("rf-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-1"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-2"))
      .mockResolvedValueOnce(makeDoneResponse());

    // New plan only lists src/target.ts — does NOT include src/already-done.ts
    replanMock.mockResolvedValue(makeNewPlan([BLOCKED_FILE]));

    await runAgentLoop({
      task: "edit multiple files",
      repoPath,
      mode: "patch",
      maxIterations: 20,
      executionPlan: makeInitialPlan(["src/already-done.ts"]),
    });

    expect(replanMock).toHaveBeenCalledTimes(1);
    const call = replanMock.mock.calls[0]![0] as Record<string, unknown>;
    // mid-edit safety: already-modified file must appear in userFeedback
    expect((call["userFeedback"] as string)).toContain("src/already-done.ts");
  });

  it("flag OFF (ZONE_PLAN_REPLAN unset): generateExecutionPlan never called", async () => {
    delete process.env["ZONE_PLAN_REPLAN"];

    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeReadFileResponse("rf-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-0"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-1"))
      .mockResolvedValueOnce(makeScopeBlockResponse("ap-2"))
      .mockResolvedValueOnce(makeDoneResponse());

    await runAgentLoop({
      task: "edit src/target.ts",
      repoPath,
      mode: "patch",
      maxIterations: 20,
      executionPlan: makeInitialPlan(["src/other.ts"]),
    });

    expect(replanMock).not.toHaveBeenCalled();
  });
});
