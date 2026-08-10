import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks (ESM TDZ-safe)
const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  generateExecutionPlan: vi.fn(),
  tryParseExecutionPlan: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./agentLoop.js", () => ({ runAgentLoop: mocks.runAgentLoop }));
vi.mock("./executionPlan.js", () => ({
  generateExecutionPlan: mocks.generateExecutionPlan,
  tryParseExecutionPlan: mocks.tryParseExecutionPlan,
}));
vi.mock("../utils/logger.js", () => ({ log: mocks.log, debugLog: vi.fn(), errorLog: vi.fn() }));

import { runPlanInvestigation, buildPrompt, PLAN_INVESTIGATION_ITER_CAP, PLAN_INVESTIGATION_MAX_FILES } from "./planInvestigation.js";

const FAKE_PLAN = {
  objective: "Add pagination",
  steps: [{ title: "Update UI", description: "Add buttons", filesLikely: ["src/ui.ts"] }],
  riskHints: [],
  scopeSummary: "Add pagination UI.",
};

function makeDoneLoop(summary = "") {
  return {
    summary,
    success: true,
    toolCallLog: [],
    filesModified: [],
    patchValidatedByAgent: false,
    verificationReason: "skipped" as const,
    iterCount: 2,
    tokenUsage: { total: 1000, input: 800, output: 200, cached: 150 },
    costUsd: 0.004,
    terminationReason: "natural_completion" as const,
  };
}

const BASE_INPUT = {
  task: "add pagination",
  repoPath: "/tmp/repo",
  runId: "run-plan-inv-001",
  relevantFiles: ["src/search.ts", "src/ui.ts", "src/api.ts"],
  repoSummary: "TypeScript webapp",
  userApiKey: "sk-ant-test",
  provider: "anthropic" as const,
  progressCallback: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runAgentLoop.mockResolvedValue(makeDoneLoop());
  mocks.generateExecutionPlan.mockResolvedValue(FAKE_PLAN);
  mocks.tryParseExecutionPlan.mockReturnValue(FAKE_PLAN);
  BASE_INPUT.progressCallback = vi.fn();
});

describe("runPlanInvestigation — agentLoop wiring", () => {
  it("calls runAgentLoop with maxIterationsOverride = PLAN_INVESTIGATION_ITER_CAP", async () => {
    await runPlanInvestigation(BASE_INPUT);
    const call = mocks.runAgentLoop.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["maxIterationsOverride"]).toBe(PLAN_INVESTIGATION_ITER_CAP);
    expect(PLAN_INVESTIGATION_ITER_CAP).toBe(6);
  });

  it("calls runAgentLoop with mode 'investigation'", async () => {
    await runPlanInvestigation(BASE_INPUT);
    const call = mocks.runAgentLoop.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["mode"]).toBe("investigation");
  });

  it("capabilityFilter includes 'read_file' but NOT 'suggest_scope_change'", async () => {
    await runPlanInvestigation(BASE_INPUT);
    const call = mocks.runAgentLoop.mock.calls[0]![0] as Record<string, unknown>;
    const filter = call["capabilityFilter"] as { allowToolNames?: Set<string> };
    expect(filter.allowToolNames?.has("read_file")).toBe(true);
    expect(filter.allowToolNames?.has("suggest_scope_change")).toBe(false);
  });

  it("does NOT pass an explicit model to runAgentLoop (model flows via requestCtx)", async () => {
    await runPlanInvestigation(BASE_INPUT);
    const call = mocks.runAgentLoop.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(call, "model")).toBe(false);
  });

  it("slices relevantFiles to PLAN_INVESTIGATION_MAX_FILES in the prompt", async () => {
    const manyFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    await runPlanInvestigation({ ...BASE_INPUT, relevantFiles: manyFiles });
    const call = mocks.runAgentLoop.mock.calls[0]![0] as Record<string, unknown>;
    const task = String(call["task"]);
    // Only the first PLAN_INVESTIGATION_MAX_FILES files appear in the prompt
    expect(task).toContain("src/file0.ts");
    expect(task).toContain(`src/file${PLAN_INVESTIGATION_MAX_FILES - 1}.ts`);
    expect(task).not.toContain(`src/file${PLAN_INVESTIGATION_MAX_FILES}.ts`);
  });

  // Hardcoded indices, not derived from PLAN_INVESTIGATION_MAX_FILES -- the sibling
  // test above tracks whatever the constant is set to and would silently pass at
  // width 5 too. This one pins the actual width: it fails if the constant regresses.
  it("passes nine files to the prompt (the ranked+grep merge width), not five", async () => {
    const manyFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    await runPlanInvestigation({ ...BASE_INPUT, relevantFiles: manyFiles });
    const call = mocks.runAgentLoop.mock.calls[0]![0] as Record<string, unknown>;
    const task = String(call["task"]);
    expect(task).toContain("src/file8.ts");
    expect(task).not.toContain("src/file9.ts");
  });
});

describe("runPlanInvestigation — parse success path", () => {
  it("returns the plan from tryParseExecutionPlan when parse succeeds", async () => {
    mocks.tryParseExecutionPlan.mockReturnValue(FAKE_PLAN);
    const result = await runPlanInvestigation(BASE_INPUT);
    expect(result).toEqual(FAKE_PLAN);
    expect(mocks.generateExecutionPlan).not.toHaveBeenCalled();
  });

  it("returns plan with scopeNotes when present in loop summary", async () => {
    const planWithScope = { ...FAKE_PLAN, scopeNotes: "auth already done" };
    mocks.tryParseExecutionPlan.mockReturnValue(planWithScope);
    const result = await runPlanInvestigation(BASE_INPUT);
    expect(result.scopeNotes).toBe("auth already done");
  });
});

// SubagentTokenUsage's four numeric fields (input/output/cached/total) are all
// REQUIRED on the interface (subagents.ts) — no `?`. That is not enforced at this
// mock boundary: mocks.runAgentLoop is an untyped vi.fn(), so mockResolvedValue
// accepts any shape (the default makeDoneLoop fixture was already missing `cached`
// before this file's own change and compiled cleanly). Block 3 below constructs a
// tokenUsage object missing three of those four required fields with NO cast —
// none is needed here, though a real (typed) caller boundary could still reject it.
describe("runPlanInvestigation — [zone-plan-investigation-complete] token breakdown", () => {
  function findMarkerPayload(): Record<string, unknown> {
    const call = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-plan-investigation-complete]"
    );
    if (!call) throw new Error("[zone-plan-investigation-complete] was not logged");
    return JSON.parse(call[1] as string) as Record<string, unknown>;
  }

  it("carries each field from the usage object at its own distinct value — not recomputed, not swapped", async () => {
    await runPlanInvestigation(BASE_INPUT);
    expect(findMarkerPayload()).toMatchObject({
      tokensUsed: 1000,
      inputTokens: 800,
      outputTokens: 200,
      cachedTokens: 150,
    });
    expect(
      mocks.log.mock.calls.filter((c: unknown[]) => c[0] === "[zone-plan-investigation-complete]")
    ).toHaveLength(1);
  });

  it("tokenUsage entirely absent — all four fields default to 0, no throw", async () => {
    mocks.runAgentLoop.mockResolvedValue({ ...makeDoneLoop(), tokenUsage: undefined });
    await expect(runPlanInvestigation(BASE_INPUT)).resolves.toBeDefined();
    expect(findMarkerPayload()).toMatchObject({
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    });
  });

  it("tokenUsage partially populated (total only) — missing fields default to 0, nothing backfilled from total", async () => {
    mocks.runAgentLoop.mockResolvedValue({ ...makeDoneLoop(), tokenUsage: { total: 500 } });
    await expect(runPlanInvestigation(BASE_INPUT)).resolves.toBeDefined();
    expect(findMarkerPayload()).toMatchObject({
      tokensUsed: 500,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    });
  });
});

describe("runPlanInvestigation — fallback path", () => {
  it("calls generateExecutionPlan as fallback when tryParseExecutionPlan returns null", async () => {
    mocks.tryParseExecutionPlan.mockReturnValue(null);
    await runPlanInvestigation(BASE_INPUT);
    expect(mocks.generateExecutionPlan).toHaveBeenCalledOnce();
    const fallback = mocks.generateExecutionPlan.mock.calls[0]![0] as Record<string, unknown>;
    expect(fallback["task"]).toBe(BASE_INPUT.task);
    expect(fallback["repoSummary"]).toBe(BASE_INPUT.repoSummary);
    expect(Array.isArray(fallback["relevantFiles"])).toBe(true);
  });

  it("fallback generateExecutionPlan receives provider and userApiKey", async () => {
    mocks.tryParseExecutionPlan.mockReturnValue(null);
    await runPlanInvestigation(BASE_INPUT);
    const fallback = mocks.generateExecutionPlan.mock.calls[0]![0] as Record<string, unknown>;
    expect(fallback["provider"]).toBe("anthropic");
    expect(fallback["userApiKey"]).toBe("sk-ant-test");
  });
});

describe("E3/S4: buildPrompt — reproduce-first + noChangeReason + cannotVerifyReason", () => {
  it("buildPrompt contains noChangeReason in JSON shape", () => {
    const prompt = buildPrompt("fix the build error", ["src/index.ts"], true);
    expect(prompt).toContain("noChangeReason");
  });

  it("buildPrompt contains cannotVerifyReason in JSON shape", () => {
    const prompt = buildPrompt("fix the build error", ["src/index.ts"], true);
    expect(prompt).toContain("cannotVerifyReason");
  });

  it("buildPrompt contains reproduce-first instruction (step 0)", () => {
    const prompt = buildPrompt("fix the build error", ["src/index.ts"], true);
    expect(prompt).toContain("exit_code=0");
    expect(prompt).toContain("npm run build");
  });

  it("buildPrompt contains BARE directive (no 2>&1/pipes)", () => {
    const prompt = buildPrompt("fix the build error", [], true);
    expect(prompt).toContain("BARE");
    expect(prompt).toContain("2>&1");
  });

  it("buildPrompt contains STOP directive for unrunnable commands", () => {
    const prompt = buildPrompt("fix the build error", [], true);
    expect(prompt).toContain("STOP");
    expect(prompt).toContain("did not run");
  });

  it("buildPrompt gates steps 1-2 on ONLY after observing the error", () => {
    const prompt = buildPrompt("fix the build error", [], true);
    expect(prompt).toContain("ONLY");
    expect(prompt).toContain("does not assert a runtime problem");
  });

  it("buildPrompt rules mention no-fabricate directive", () => {
    const prompt = buildPrompt("fix failing tests", [], true);
    expect(prompt).toContain("Never fabricate steps");
  });

  it("buildPrompt(allowAnswerOnly=true) documents answerOnlyReason; allowAnswerOnly=false omits it", () => {
    const withAnswerOnly = buildPrompt("fix the build error", ["src/index.ts"], true);
    expect(withAnswerOnly).toContain("answerOnlyReason");

    const withoutAnswerOnly = buildPrompt("fix the build error", ["src/index.ts"], false);
    expect(withoutAnswerOnly).not.toContain("answerOnlyReason");

    // The criterion is what the investigation CONCLUDED, not the task's surface form.
    // Five consecutive real-model draws set answerOnlyReason on tasks with real defects,
    // and every one of their reason fields quoted the old prompt's first conjunct back
    // ("a question, not a change request") while ignoring its second. A control draw with
    // allowAnswerOnly=false produced concrete steps for a byte-identical task, which is
    // what identified the wording rather than the model as the cause.
    expect(withAnswerOnly).toContain("correct and deliberate");
    // The n=38 corpus found no surface-form rule separates "wants an answer" from "wants
    // a fix", so a NARROWER surface-form rule would be the same defect with a smaller
    // blast radius. This pins that the phrasing-keyed criterion stays gone.
    expect(withAnswerOnly).not.toContain("TASK itself is a question");
  });

  it("no-change plan from tryParseExecutionPlan skips fallback generateExecutionPlan", async () => {
    const noChangePlan = {
      objective: "Verify build",
      steps: [],
      riskHints: [],
      scopeSummary: "No changes needed.",
      noChangeReason: "npm run build exits 0",
    };
    mocks.tryParseExecutionPlan.mockReturnValue(noChangePlan);
    const result = await runPlanInvestigation(BASE_INPUT);
    expect(result).toEqual(noChangePlan);
    expect(mocks.generateExecutionPlan).not.toHaveBeenCalled();
  });

  it("cannotVerify plan from tryParseExecutionPlan skips fallback generateExecutionPlan", async () => {
    const cantVerifyPlan = {
      objective: "Verify build",
      steps: [],
      riskHints: [],
      scopeSummary: "Could not verify.",
      cannotVerifyReason: "Could not verify — npm run build did not run; premise unconfirmed.",
    };
    mocks.tryParseExecutionPlan.mockReturnValue(cantVerifyPlan);
    const result = await runPlanInvestigation(BASE_INPUT);
    expect(result).toEqual(cantVerifyPlan);
    expect(mocks.generateExecutionPlan).not.toHaveBeenCalled();
  });
});

describe("runPlanInvestigation — streaming (progressCallback)", () => {
  it("emits a tool_call progress event when onToolCall fires", async () => {
    mocks.runAgentLoop.mockImplementationOnce(async (input: Record<string, unknown>) => {
      const onToolCall = input["onToolCall"] as (name: string, args: Record<string, unknown>) => void;
      onToolCall("read_file", { filePath: "src/auth.ts" });
      return makeDoneLoop();
    });
    await runPlanInvestigation(BASE_INPUT);
    const calls = (BASE_INPUT.progressCallback as ReturnType<typeof vi.fn>).mock.calls;
    const toolCallUpdate = calls.find(([upd]: [any]) =>
      typeof upd === "object" && upd?.progress?.type === "tool_call"
    );
    expect(toolCallUpdate).toBeDefined();
    expect(toolCallUpdate![0].progress.title).toContain("read_file");
  });

  it("emits a narration event when onStructuredEvent receives type='narration'", async () => {
    mocks.runAgentLoop.mockImplementationOnce(async (input: Record<string, unknown>) => {
      const onStructuredEvent = input["onStructuredEvent"] as (evt: unknown) => void;
      onStructuredEvent({ type: "narration", title: "Reading auth module", text: "..." });
      return makeDoneLoop();
    });
    await runPlanInvestigation(BASE_INPUT);
    const calls = (BASE_INPUT.progressCallback as ReturnType<typeof vi.fn>).mock.calls;
    const narration = calls.find(([upd]: [any]) =>
      typeof upd === "object" && upd?.progress?.type === "narration"
    );
    expect(narration).toBeDefined();
    expect(narration![0].progress.title).toBe("Reading auth module");
  });

  it("emits a synthetic iter_cost_update carrying loop.costUsd after the loop", async () => {
    await runPlanInvestigation(BASE_INPUT);
    const calls = (BASE_INPUT.progressCallback as ReturnType<typeof vi.fn>).mock.calls;
    const costUpdate = calls.find(([upd]: [any]) =>
      typeof upd === "object" && upd?.progress?.type === "iter_cost_update"
    );
    expect(costUpdate).toBeDefined();
    expect(costUpdate![0].progress.cumulativeCost).toBe(0.004);
  });
});

