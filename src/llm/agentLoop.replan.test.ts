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

import { runAgentLoop, addBlockedPathToPlan } from "./agentLoop.js";
import { checkWriteScope } from "../tools/scopeGuard.js";

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

// ── Inc-3 helpers ──────────────────────────────────────────────────────────────

function makeScopeChangeResponse(id: string, args?: Partial<Record<string, unknown>>) {
  return makeToolCallResponse(id, "suggest_scope_change", {
    type: "under_scope",
    reason: "src/target.ts needs edits but is missing from the plan",
    revised_plan_summary: "Edit src/target.ts to apply the fix",
    missing_files: [BLOCKED_FILE],
    ...args,
  });
}

// ── Inc-3 tests ────────────────────────────────────────────────────────────────

describe("agentLoop adaptive replan (Inc-3 — agent-driven via suggest_scope_change)", () => {
  it("flag ON + valid proposal → performReplan fires, ack contains 'Plan revised'", async () => {
    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeScopeChangeResponse("sc-0"))
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
    const call = replanMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(call["userFeedback"])).toContain("src/target.ts needs edits");
    expect(String(call["userFeedback"])).toContain("Edit src/target.ts to apply the fix");
    expect(events.find((e) => (e as { type?: string }).type === "todo_revised")).toBeDefined();
  });

  it("shared one-shot guard: agent-driven replan then 3 scope-blocks → replanMock called exactly once", async () => {
    // suggest_scope_change fires first (replanState.count→1); the subsequent 3 scope-blocks
    // see count < 1 = false in handleToolResult and fall through to the nudge, not replan_signal.
    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeScopeChangeResponse("sc-0"))
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
  });

  it("flag OFF → patch-mode suggest_scope_change stays a no-op", async () => {
    delete process.env["ZONE_PLAN_REPLAN"];

    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeScopeChangeResponse("sc-0"))
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

  it("investigation mode: suggest_scope_change takes the old investigation path, replanMock not called", async () => {
    // In investigation mode, !isInvestigationMode is false so the patch-mode replan branch
    // is never entered. The investigation handler at :3560 fires and acks "Scope change
    // proposal recorded." Pass capabilityFilter to ensure the tool reaches the handler.
    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeScopeChangeResponse("sc-0"))
      .mockResolvedValueOnce(makeDoneResponse());

    const events: unknown[] = [];
    await runAgentLoop({
      task: "investigate src/target.ts",
      repoPath,
      mode: "investigate",
      maxIterations: 20,
      capabilityFilter: { allowToolNames: new Set(["read_file", "suggest_scope_change"]) },
      onStructuredEvent: (e) => events.push(e),
    });

    expect(replanMock).not.toHaveBeenCalled();
    // investigation handler emits the suggest_scope_change structured event
    expect(events.find((e) => (e as { type?: string }).type === "suggest_scope_change")).toBeDefined();
  });

  it("Inc-2 regression: scope-block replan still works via extracted performReplan helper", async () => {
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
    const call = replanMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(call["userFeedback"])).toContain(BLOCKED_FILE);
    expect(events.find((e) => (e as { type?: string }).type === "todo_revised")).toBeDefined();
  });
});

// ── addBlockedPathToPlan (extracted pure helper) ────────────────────────────────
// Direct unit tests, independent of the integration harness above. The harness
// structurally cannot reach a state where blockedPath is absent from
// filesModified — handleToolResult's Step 9 records every write attempt's
// filePath unconditionally, in the same call that later detects the 3rd
// consecutive block, before replan_signal is even returned — so these are the
// only tests that isolate the explicit add from that accident.

describe("addBlockedPathToPlan", () => {
  it("pushes blockedPath into steps[0].filesLikely and newPlanPaths when absent", () => {
    const plan = makeNewPlan(["src/other.ts"]);
    const newPlanPaths = new Set(["src/other.ts"]); // NOT filesModified-shaped —
    // the function takes no filesModified-like parameter at all.
    addBlockedPathToPlan(plan, newPlanPaths, BLOCKED_FILE);
    expect(plan.steps[0]!.filesLikely).toEqual(["src/other.ts", BLOCKED_FILE]);
    expect(newPlanPaths.has(BLOCKED_FILE)).toBe(true);
  });

  it("does not duplicate when blockedPath is already in newPlanPaths", () => {
    const plan = makeNewPlan([BLOCKED_FILE]);
    const newPlanPaths = new Set([BLOCKED_FILE]);
    addBlockedPathToPlan(plan, newPlanPaths, BLOCKED_FILE);
    expect(plan.steps[0]!.filesLikely).toEqual([BLOCKED_FILE]);
    expect(newPlanPaths.size).toBe(1);
  });

  it("no-ops when blockedPath is undefined", () => {
    const plan = makeNewPlan(["src/other.ts"]);
    const newPlanPaths = new Set(["src/other.ts"]);
    addBlockedPathToPlan(plan, newPlanPaths, undefined);
    expect(plan.steps[0]!.filesLikely).toEqual(["src/other.ts"]);
    expect(newPlanPaths.size).toBe(1);
  });

  it("pushes blockedPath verbatim — no normalization applied inside the helper", () => {
    const weird = "./nested/../src/target.ts";
    const plan = makeNewPlan([]);
    const newPlanPaths = new Set<string>();
    addBlockedPathToPlan(plan, newPlanPaths, weird);
    expect(plan.steps[0]!.filesLikely).toEqual([weird]);
  });
});

// ── Bug-fix: performReplan force-adds blockedPath into filesLikely ──────────────

describe("agentLoop adaptive replan — blockedPath force-add", () => {
  it("force-adds blockedPath to filesLikely when the regenerated plan omits it", async () => {
    // New plan intentionally omits BLOCKED_FILE — unlike every other test in this
    // file, which defaults to a plan that already contains it.
    replanMock.mockResolvedValue(makeNewPlan(["src/unrelated.ts"]));

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
    ) as { todos: Array<{ filesLikely?: string[] }> } | undefined;
    expect(todoRevisedEvent).toBeDefined();
    expect(todoRevisedEvent!.todos[0]!.filesLikely).toContain(BLOCKED_FILE);
  });

  it("the widened plan passes the real checkWriteScope check for the blocked path", async () => {
    replanMock.mockResolvedValue(makeNewPlan(["src/unrelated.ts"]));

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
    ) as { todos: Array<{ filesLikely?: string[] }> } | undefined;
    expect(todoRevisedEvent).toBeDefined();
    const widenedFilesLikely = todoRevisedEvent!.todos[0]!.filesLikely ?? [];
    // Reuse makeNewPlan to build a real, fully-shaped ExecutionPlan around the
    // captured filesLikely — feeds the REAL, unmocked scope guard, not a stub.
    expect(checkWriteScope(BLOCKED_FILE, makeNewPlan(widenedFilesLikely))).toBeNull();
  });

  it("Site A (agent_suggest_scope_change, no blockedPath): nothing extra beyond the regenerated plan's own filesLikely gets added", async () => {
    // blockedPath is never set on this path — no single blocked-path concept for
    // agent-driven scope changes. Empty filesLikely on both the mocked new plan
    // and filesModified (no prior write in this sequence) makes any spurious
    // addition from the new guard immediately visible.
    replanMock.mockResolvedValue(makeNewPlan([]));
    llmMock.createChatCompletion
      .mockResolvedValueOnce(makeScopeChangeResponse("sc-0"))
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
    ) as { todos: Array<{ filesLikely?: string[] }> } | undefined;
    expect(todoRevisedEvent).toBeDefined();
    expect(todoRevisedEvent!.todos[0]!.filesLikely).toEqual([]);
  });
});
