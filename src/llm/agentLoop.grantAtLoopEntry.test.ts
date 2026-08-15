/**
 * Item 167: the plan-derived tool grant relocated from dispatch time
 * (runLlmPatchFlow.ts's _dispatcherCapabilityFilter construction) to loop
 * entry in agentLoop.ts, where effectiveFilter is resolved. Migrates the
 * seven scenarios that used to live in
 * runLlmPatchFlow.readOnlySuppression.test.ts (mocking runAgentLoop entirely,
 * which can no longer exercise a mechanism that now lives inside it) onto the
 * real runAgentLoop harness already established in
 * agentLoop.toolAbsenceNoticeWiring.test.ts / agentLoop.tierArchetypeMismatch.test.ts.
 *
 * Also covers the two approval additions (byte-identity/ordering on the ARRAY
 * actually sent to the provider, and the never-exceed-complex-tier invariant
 * with its cost telemetry) — and a load-bearing finding this pass's own test
 *-writing surfaced: TIER_LIMITS.simple/.medium fix maxSubagentCalls at 0
 * UNCONDITIONALLY, so "Task" specifically can never reach the array sent to
 * the provider at those tiers regardless of any grant. The filter is
 * correctly widened (provable, tested below); the array is stripped by a
 * separate, pre-existing, always-on gate one step later. "Task granted, 5→6
 * in the array" was this pass's own first design for a scenario that is
 * architecturally impossible — corrected here, not silently absorbed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import type { ExecutionPlan } from "./executionPlan.js";
import type { TaskClassification } from "./taskClassifier.js";

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
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));
vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);
vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop.js";

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "[ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

function makeToolCallResponse(name: string, args: string, id = "call_1") {
  return {
    choices: [
      { message: { content: null, tool_calls: [{ type: "function", id, function: { name, arguments: args } }] }, finish_reason: "tool_calls" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// estimatedFiles/estimatedIterations deliberately large: confirmed by running
// resolveTierLimits directly that taskBlockedByBudget is UNCONDITIONALLY true
// at simple/medium tier regardless of these values (maxSubagentCalls is a
// per-tier constant of 0 there) — these values are set large only so that
// fact is not confused with "the classification happened to look small".
function makeClassification(overrides: { archetype?: string; tier?: string } = {}): TaskClassification {
  return {
    tier: (overrides.tier ?? "simple") as TaskClassification["tier"],
    archetype: (overrides.archetype ?? "targeted_fix") as TaskClassification["archetype"],
    archetypeConfidence: 0.8,
    confidence: 0.9,
    estimatedFiles: 10,
    estimatedIterations: 20,
    classifierCostUsd: 0.001,
    classifierLatencyMs: 200,
    classifierModel: "claude-sonnet-4-6",
    fallbackUsed: false,
  };
}

const APPROVED_PLAN: ExecutionPlan = {
  objective: "Add a helper",
  steps: [{ title: "Add helper", description: "Add a small helper function.", filesLikely: ["src/utils/foo.ts"] }],
  scopeSummary: "Add a helper",
  riskHints: [],
};

function markedStep(
  filesLikely: string[],
  subagentType: "worker" | "explore" = "worker"
): ExecutionPlan["steps"][number] {
  return { title: "step", description: "d", filesLikely, subagentEligible: true, subagentType };
}

function planWithMarkedSteps(steps: ExecutionPlan["steps"], requestedTools?: string[]): ExecutionPlan {
  return { ...APPROVED_PLAN, steps, ...(requestedTools ? { requestedTools } : {}) };
}

function planWithRequestedTools(requestedTools: string[]): ExecutionPlan {
  return { ...APPROVED_PLAN, requestedTools };
}

function grantLogs() {
  return mocks.log.mock.calls.filter((c) => c[0] === "[zone-requested-tools-granted]");
}
function promotionLogs() {
  return mocks.log.mock.calls.filter((c) => c[0] === "[zone-archetype-promoted]");
}
function payloadOf(call: unknown[]) {
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-grant-loop-entry-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "ok" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function captureToolsAndSystem() {
  let tools: Array<{ function: { name: string } }> | undefined;
  let systemContent: string | undefined;
  mocks.createChatCompletion.mockImplementation(
    async (params: { tools?: typeof tools; messages?: Array<{ role: string; content: unknown }> }) => {
      if (tools === undefined) {
        tools = params.tools;
        const sys = params.messages?.find((m) => m.role === "system");
        systemContent = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content);
      }
      return makeDoneResponse();
    }
  );
  return { tools: () => tools, systemContent: () => systemContent };
}

function withheldList(systemContent: string): string[] {
  const noticeStart = systemContent.indexOf("TOOLS NOT AVAILABLE THIS RUN");
  if (noticeStart < 0) return [];
  const noticeEnd = systemContent.indexOf("\n\n", noticeStart);
  const notice = systemContent.slice(noticeStart, noticeEnd);
  return notice.slice(notice.indexOf(": ") + 2).split(", ").map((s) => s.trim());
}

describe("item 167 — ordering pin: the grant must land before every downstream consumer", () => {
  it("granting TodoWrite lands BEFORE offeredToolNames/toolAbsenceBlock: PLAN VISIBILITY renders, TodoWrite is not named withheld", async () => {
    // TodoWrite (not Task) is the vehicle here specifically because it is not
    // subject to the separate taskBlockedByBudget gate that strips Task from
    // toolsForLLM regardless of any grant (see the file-level doc comment).
    const cap = captureToolsAndSystem();

    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-ordering-pin",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
      executionPlan: planWithRequestedTools(["TodoWrite"]),
    });

    const sys = cap.systemContent();
    expect(sys).toBeDefined();
    // PLAN VISIBILITY is gated on isOffered("TodoWrite") — only renders if the
    // grant landed before offeredToolNames was computed from toolsForLLM.
    expect(sys).toContain("PLAN VISIBILITY (TodoWrite)");
    expect(withheldList(sys!)).not.toContain("TodoWrite");

    const toolNames = cap.tools()?.map((t) => t.function.name) ?? [];
    expect(toolNames).toContain("TodoWrite");
  });
});

describe("item 167 — byte-identity and ordering on the ARRAY sent to the provider (approval addition 1)", () => {
  it("no executionPlan at all vs. an executionPlan with nothing to grant: the tools array is byte-identical, in order", async () => {
    const capNoPlan = captureToolsAndSystem();
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-noplan",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
    });
    const arrNoPlan = capNoPlan.tools();

    mocks.createChatCompletion.mockReset();
    mocks.log.mockReset();
    const capNothingToGrant = captureToolsAndSystem();
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-nothing-to-grant",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
      executionPlan: APPROVED_PLAN, // present, but no marks and no requestedTools
    });
    const arrNothingToGrant = capNothingToGrant.tools();

    expect(arrNoPlan).toBeDefined();
    expect(arrNothingToGrant).toBeDefined();
    expect(JSON.stringify(arrNothingToGrant)).toBe(JSON.stringify(arrNoPlan));

    // Neither cell should have produced a marker — the grant block's outer
    // condition never evaluates true in either case.
    expect(grantLogs().length).toBe(0);
  });

  it("after a successful grant, the array is still alphabetically sorted with the granted name at its sorted position, not appended", async () => {
    const cap = captureToolsAndSystem();
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-sorted-after-grant",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
      executionPlan: planWithRequestedTools(["TodoWrite"]),
    });
    const names = (cap.tools() ?? []).map((t) => t.function.name);
    expect(names).toContain("TodoWrite");
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted); // the whole array is re-sorted from scratch every time — no append exists
  });
});

describe("item 167 — the Task/subagent-budget-gate interaction (finding, not a defect)", () => {
  it("qualifying plan mark grants Task at the FILTER level, but Task never reaches the array at simple tier — a separate, pre-existing, always-on gate", async () => {
    const cap = captureToolsAndSystem();
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-tf-simple-task-budget-gated",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
      executionPlan: planWithMarkedSteps([markedStep(["a.ts", "b.ts", "c.ts", "d.ts"])]),
    });

    // Filter-level: the grant genuinely fired and "succeeded" — this is the
    // superset property applyRequestedToolsGrant already guarantees.
    const call = grantLogs()[0];
    expect(call).toBeDefined();
    const payload = payloadOf(call!);
    expect(payload.granted).toEqual(["Task"]);

    // Array-level: Task still never reaches the request the provider sees —
    // toolArrayLengthAfter reports the REAL outcome (unchanged at 5), not the
    // filter's own resolution (which would have been 6).
    expect(payload.toolArrayLengthBefore).toBe(5);
    expect(payload.toolArrayLengthAfter).toBe(5);
    expect(payload.toolDescriptionCharsAdded).toBe(0); // nothing was actually added to the request

    const names = (cap.tools() ?? []).map((t) => t.function.name);
    expect(names).not.toContain("Task");
    expect(names.length).toBe(5);
  });

  it("the same interaction holds at medium tier (maxSubagentCalls is also 0 there, unconditionally)", async () => {
    const cap = captureToolsAndSystem();
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-tf-medium-task-budget-gated",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "medium" }),
      executionPlan: planWithRequestedTools(["Task"]),
    });
    const payload = payloadOf(grantLogs()[0]!);
    expect(payload.granted).toEqual(["Task"]);
    expect(payload.toolArrayLengthBefore).toBe(payload.toolArrayLengthAfter);
    expect((cap.tools() ?? []).map((t) => t.function.name)).not.toContain("Task");
  });
});

describe("item 167 — grant scenarios migrated from runLlmPatchFlow.readOnlySuppression.test.ts", () => {
  it("targeted_fix @ simple tier, qualifying mark on a non-Task name → granted end-to-end, superset invariant, offered 5 → 6", async () => {
    // TodoWrite substituted for Task in this scenario's original design — see
    // the file-level doc comment for why Task itself cannot demonstrate this.
    const cap = captureToolsAndSystem();
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-tf-simple-qualify",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
      executionPlan: planWithRequestedTools(["TodoWrite"]),
    });
    const names = new Set((cap.tools() ?? []).map((t) => t.function.name));
    expect(names.has("TodoWrite")).toBe(true);
    expect(names.size).toBe(6); // SIMPLE_TIER_TOOLS (5) + TodoWrite
    for (const n of ["apply_patch", "multi_edit", "read_file", "run_command", "write_file"]) {
      expect(names.has(n)).toBe(true); // strict superset — nothing pre-existing dropped
    }

    const payload = payloadOf(grantLogs()[0]!);
    expect(payload.granted).toEqual(["TodoWrite"]);
    expect(payload.iter).toBe(0);
    expect(payload.toolArrayLengthBefore).toBe(5);
    expect(payload.toolArrayLengthAfter).toBe(6);
    expect(payload.toolDescriptionCharsAdded).toBeGreaterThan(0);
  });

  it("targeted_fix @ complex tier → ceiling empty (no dispatcher filter, no tier filter), no grant, reason recorded", async () => {
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-tf-complex-empty",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "complex" }),
      executionPlan: planWithMarkedSteps([markedStep(["a.ts", "b.ts", "c.ts", "d.ts"])]),
    });
    const call = grantLogs()[0];
    expect(call).toBeDefined();
    const payload = payloadOf(call!);
    expect(payload.granted).toEqual([]);
    expect(payload.dropped).toEqual([{ name: "Task", reason: "not_dispatcher_excluded", source: "plan_marks" }]);
    expect(payload.toolArrayLengthBefore).toBe(payload.toolArrayLengthAfter); // unchanged
  });

  it("explicit requestedTools naming 3 in-ceiling tools → all 3 granted end-to-end, cap respected", async () => {
    const cap = captureToolsAndSystem();
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-explicit-three",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
      executionPlan: planWithRequestedTools(["TodoWrite", "ask_user", "fetch_url"]),
    });
    const names = new Set((cap.tools() ?? []).map((t) => t.function.name));
    for (const n of ["TodoWrite", "ask_user", "fetch_url"]) expect(names.has(n)).toBe(true);

    const payload = payloadOf(grantLogs()[0]!);
    expect((payload.granted as string[]).sort()).toEqual(["TodoWrite", "ask_user", "fetch_url"].sort());
  });

  it("explicit requestedTools naming 4 → capped at 3, the 4th recorded over_cap_truncated", async () => {
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-explicit-four",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
      executionPlan: planWithRequestedTools(["Task", "TodoWrite", "ask_user", "fetch_url"]),
    });
    const payload = payloadOf(grantLogs()[0]!);
    expect((payload.granted as string[]).length).toBe(3);
    expect(payload.dropped).toContainEqual({ name: "fetch_url", reason: "over_cap_truncated", source: "explicit" });
  });

  it("both channels naming Task → exactly one grant, one telemetry line, flag transitions once", async () => {
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-both-channels",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
      executionPlan: planWithMarkedSteps([markedStep(["a.ts", "b.ts", "c.ts"])], ["Task"]),
    });
    const calls = grantLogs();
    expect(calls.length).toBe(1); // one grant, not two, regardless of Task's own array fate
    const payload = payloadOf(calls[0]!);
    expect(payload.granted).toEqual(["Task"]);
    expect(payload.requested).toEqual([{ name: "Task", source: "explicit" }]);
  });
});

describe("item 167 — never-exceed-complex-tier invariant", () => {
  it("a grant can never resolve to more tools than the full registry", async () => {
    const cap = captureToolsAndSystem();
    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-never-exceed",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "medium" }),
      executionPlan: planWithRequestedTools(["Task", "ask_user", "fetch_url"]),
    });
    const names = cap.tools() ?? [];
    // full registry is 20 tools — never observed to exceed it regardless of tier/grant
    expect(names.length).toBeLessThanOrEqual(20);
  });
});

describe("item 167 — mutation 4's own test: a grant and a later forced_tier_blocking promotion are independent", () => {
  it("a run that already took a plan-derived grant can still promote later from observed mid-loop failure", async () => {
    // Exact T.8 recipe from agentLoop.tierArchetypeMismatch.test.ts: 3x read_file on the
    // same path (repeat-read threshold), then an apply_patch failure at iter>=2.
    mocks.createChatCompletion
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c1"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c2"))
      .mockResolvedValueOnce(makeToolCallResponse("read_file", '{"filePath":"src/foo.ts"}', "c3"))
      .mockResolvedValueOnce(makeToolCallResponse("apply_patch", '{"filePath":"src/foo.ts","blocks":[]}', "c4"));

    toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
      if (name === "apply_patch") return { success: false, output: "patch rejected: line mismatch" };
      return { success: true, output: "ok" };
    });

    await runAgentLoop({
      task: "fix the failing test",
      repoPath,
      runId: "run-grant-then-promotion",
      forceTier: "simple",
      taskClassification: makeClassification({ archetype: "targeted_fix", tier: "simple" }),
      executionPlan: planWithMarkedSteps([markedStep(["a.ts", "b.ts", "c.ts"])]),
    });

    // The plan-derived grant fires (filter-level — Task's array fate is
    // orthogonal to this test's point, which is the promotion trigger below).
    const grant = grantLogs();
    expect(grant.length).toBe(1);
    expect(payloadOf(grant[0]!).granted).toEqual(["Task"]);

    const promo = promotionLogs();
    expect(promo.length).toBe(1);
    const promoPayload = payloadOf(promo[0]!);
    expect(promoPayload.trigger).toBe("forced_tier_blocking");
    expect(promoPayload.fromArchetype).toBe("targeted_fix");
  });
});
