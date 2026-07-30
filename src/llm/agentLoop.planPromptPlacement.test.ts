/**
 * Plan mode §2 — the approved plan's full content (objective, steps, risks, scope)
 * must reach the execution prompt, and it must do so in the first user message, never
 * the system prompt (cache breakpoint #1 is static-once-per-run; breakpoint #2 is the
 * only place per-run content can safely live — see agentLoop.ts's sessionMemBlock/
 * auditContextBlock/restageSeedBlock/resumeBlock precedents).
 *
 * Placement-specific, not presence-only: every positive assertion checks the message
 * with role:"user" specifically, and a companion assertion confirms the block's header
 * is absent from the role:"system" message — the assertion that actually breaks if a
 * future refactor moves the block into the system prompt.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import type { ExecutionPlan } from "./executionPlan.js";

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

const replanMock = vi.hoisted(() => vi.fn());

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

// Spread the real module so buildApprovedPlanBlock/formatPlanRevisedNote/
// formatExecutionPlanForPrompt stay real — only generateExecutionPlan (the replan
// path's own LLM call) is replaced, matching agentLoop.replan.test.ts's pattern.
vi.mock("./executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./executionPlan.js")>();
  return { ...actual, generateExecutionPlan: replanMock };
});

import { runAgentLoop } from "./agentLoop.js";

type CapturedMessage = { role: string; content: unknown };

function makeToolCallResponse(id: string, toolName: string, args: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeDoneResponse(text = "Task complete.") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const FIXTURE_PLAN: ExecutionPlan = {
  objective: "OBJECTIVE_MARKER_xyz",
  steps: [{ title: "STEP_TITLE_MARKER_abc", description: "STEP_DESC_MARKER_def", filesLikely: ["src/foo.ts"] }],
  riskHints: ["RISK_MARKER_ghi"],
  scopeSummary: "SCOPE_MARKER_jkl",
};

const APPROVED_PLAN_HEADER = "--- APPROVED PLAN ---";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-plan-prompt-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  replanMock.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
  delete process.env["ZONE_PLAN_REPLAN"];
});

describe("agentLoop — approved plan reaches the first user message, not the system prompt", () => {
  it("threads objective, step title, step description, scopeSummary, and a riskHint into the user message specifically", async () => {
    let messages: CapturedMessage[] = [];
    mocks.createChatCompletion.mockImplementationOnce(async (params: { messages: CapturedMessage[] }) => {
      messages = params.messages;
      return makeDoneResponse();
    });

    await runAgentLoop({
      task: "some task",
      repoPath,
      executionPlan: FIXTURE_PLAN,
      planApproved: true,
      maxIterationsOverride: 3,
    });

    const systemMsg = messages.find((m) => m.role === "system");
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const userText = String(userMsg!.content);

    // Order matters for the mutation tests below: objective first, riskHint last.
    expect(userText).toContain(FIXTURE_PLAN.objective);
    expect(userText).toContain(FIXTURE_PLAN.steps[0]!.title);
    expect(userText).toContain(FIXTURE_PLAN.steps[0]!.description);
    expect(userText).toContain(FIXTURE_PLAN.scopeSummary);
    expect(userText).toContain(FIXTURE_PLAN.riskHints[0]);

    // Placement pin: the block must not be in the system prompt. This is the
    // assertion that breaks if a future refactor moves it there.
    expect(systemMsg).toBeDefined();
    expect(String(systemMsg!.content)).not.toContain(APPROVED_PLAN_HEADER);
  });

  it("does not inject the plan block at all when no executionPlan is given (header absent, not merely empty)", async () => {
    let messages: CapturedMessage[] = [];
    mocks.createChatCompletion.mockImplementationOnce(async (params: { messages: CapturedMessage[] }) => {
      messages = params.messages;
      return makeDoneResponse();
    });

    await runAgentLoop({ task: "some task", repoPath, maxIterationsOverride: 3 });

    const userMsg = messages.find((m) => m.role === "user");
    expect(String(userMsg!.content)).not.toContain(APPROVED_PLAN_HEADER);
  });

  it("scope-guard pin: does not inject the block when executionPlan is present but planApproved is not set", async () => {
    let messages: CapturedMessage[] = [];
    mocks.createChatCompletion.mockImplementationOnce(async (params: { messages: CapturedMessage[] }) => {
      messages = params.messages;
      return makeDoneResponse();
    });

    // executionPlan set, planApproved deliberately omitted — the non-plan-mode
    // default path's own self-generated, never-reviewed plan looks exactly like this.
    await runAgentLoop({ task: "some task", repoPath, executionPlan: FIXTURE_PLAN, maxIterationsOverride: 3 });

    const userMsg = messages.find((m) => m.role === "user");
    expect(String(userMsg!.content)).not.toContain(APPROVED_PLAN_HEADER);
  });
});

describe("agentLoop — replan append-only invariant", () => {
  const BLOCKED_FILE = "src/target.ts";
  const REVISED_MARKER = "REVISED_OBJECTIVE_MARKER_qrs";

  function makeReadFileResponse(id: string, filePath = BLOCKED_FILE) {
    return makeToolCallResponse(id, "read_file", { filePath });
  }
  function makeScopeBlockResponse(id: string, filePath = BLOCKED_FILE) {
    return makeToolCallResponse(id, "apply_patch", { filePath, patch: "--- FIND ---\nold\n--- REPLACE ---\nnew" });
  }

  const SCOPE_BLOCK_RESULT = {
    success: false,
    output: `Write blocked: "${BLOCKED_FILE}" is outside the planned scope.`,
    error: "apply_patch_blocked_out_of_plan_scope",
  };
  const READ_SUCCESS_RESULT = { success: true, output: "// file content" };

  function makeInitialPlan(): ExecutionPlan {
    return {
      objective: "Initial objective",
      steps: [{ title: "Step 1", description: "Make changes", filesLikely: ["src/other.ts"] }],
      riskHints: [],
      scopeSummary: "original scope",
    };
  }
  function makeRevisedPlan(): ExecutionPlan {
    return {
      objective: REVISED_MARKER,
      steps: [{ title: "Edit target", description: "Apply the required change", filesLikely: [BLOCKED_FILE] }],
      riskHints: [],
      scopeSummary: "updated scope",
    };
  }

  it("appends the revised plan as new content without rewriting any previously-sent message", async () => {
    process.env["ZONE_PLAN_REPLAN"] = "1";

    // Deep-clone at capture time — params.messages (== responseInput/prunedMessages) is a
    // live, mutated-in-place structure (Pattern-A appends reassign an EXISTING message
    // object's .content), so a shallow push here would let a later mutation retroactively
    // "appear" in an earlier snapshot. Same reference-sharing trap agentLoop.cacheStability
    // .test.ts's own T.1 comment warns about, one level deeper (object identity, not just
    // array length).
    const allCalls: CapturedMessage[][] = [];
    toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
      if (name === "read_file") return READ_SUCCESS_RESULT;
      return SCOPE_BLOCK_RESULT;
    });
    replanMock.mockResolvedValue(makeRevisedPlan());
    mocks.createChatCompletion.mockImplementation(async (params: { messages: CapturedMessage[] }) => {
      allCalls.push(JSON.parse(JSON.stringify(params.messages)));
      const n = allCalls.length;
      if (n === 1) return makeReadFileResponse("rf-0");
      if (n === 2) return makeScopeBlockResponse("ap-0");
      if (n === 3) return makeScopeBlockResponse("ap-1");
      if (n === 4) return makeScopeBlockResponse("ap-2");
      return makeDoneResponse();
    });

    await runAgentLoop({
      task: "edit src/target.ts",
      repoPath,
      mode: "patch",
      maxIterations: 20,
      executionPlan: makeInitialPlan(),
      planApproved: true,
    });

    expect(replanMock).toHaveBeenCalledTimes(1);
    expect(allCalls.length).toBeGreaterThanOrEqual(5);

    const firstCall = allCalls[0]!;
    const lastCall = allCalls[allCalls.length - 1]!;

    // Append-only invariant, as it actually applies: every message present at the
    // first call must be byte-identical, in the same order, to the corresponding
    // prefix of the last call's messages — not just the first user message alone,
    // since a rewrite or reorder of ANY earlier message would invalidate the cache
    // the same way, and a message[0]-only check would stay green through that.
    expect(lastCall.slice(0, firstCall.length)).toEqual(firstCall);

    // The revised plan's content must be genuinely new — present only beyond that
    // stable prefix, never in the first call at all.
    const firstCallText = firstCall.map((m) => String(m.content)).join("\n");
    const newTailText = lastCall.slice(firstCall.length).map((m) => String(m.content)).join("\n");
    expect(firstCallText).not.toContain(REVISED_MARKER);
    expect(newTailText).toContain(REVISED_MARKER);
  });
});
