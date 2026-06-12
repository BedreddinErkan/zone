import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPlanInvestigation } from "./planInvestigation.js";
import { PlanRefusalError } from "./factory.js";

// Mock runAgentLoop and generateExecutionPlan — both are used inside runPlanInvestigation.
vi.mock("./agentLoop.js", () => ({ runAgentLoop: vi.fn() }));
vi.mock("./executionPlan.js", () => ({
  generateExecutionPlan: vi.fn(),
  tryParseExecutionPlan: vi.fn((text: string) => {
    try {
      const m = text.match(/```json\s*([\s\S]*?)```/);
      if (!m) return null;
      return JSON.parse(m[1]!);
    } catch { return null; }
  }),
}));

import { runAgentLoop } from "./agentLoop.js";
import { generateExecutionPlan } from "./executionPlan.js";

function baseLoopResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    summary: "",
    toolCallLog: [],
    filesModified: [],
    patchValidatedByAgent: false,
    verificationReason: "no_verification_attempted" as const,
    terminationReason: "natural_completion" as const,
    costUsd: 0,
    iterCount: 1,
    ...overrides,
  };
}

const BASE_INPUT = {
  task: "add a feature",
  repoPath: "/repo",
  runId: "run-test",
  relevantFiles: [],
  repoSummary: "summary",
  progressCallback: () => {},
};

beforeEach(() => {
  vi.mocked(runAgentLoop).mockReset();
  vi.mocked(generateExecutionPlan).mockReset();
});

describe("runPlanInvestigation — refusal detection", () => {
  it("loop.refusal set → throws PlanRefusalError with decline reason and costUsd", async () => {
    vi.mocked(runAgentLoop).mockResolvedValue(
      baseLoopResult({ refusal: "Declined by safety classifier (category: cyber)", costUsd: 0.012 })
    );

    await expect(runPlanInvestigation(BASE_INPUT)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PlanRefusalError &&
        e.declineReason === "Declined by safety classifier (category: cyber)" &&
        e.costUsd === 0.012
    );
  });

  it("loop.refusal set → generateExecutionPlan fallback NOT called", async () => {
    vi.mocked(runAgentLoop).mockResolvedValue(
      baseLoopResult({ refusal: "Declined by safety classifier", costUsd: 0.005 })
    );

    await expect(runPlanInvestigation(BASE_INPUT)).rejects.toBeInstanceOf(PlanRefusalError);
    expect(generateExecutionPlan).not.toHaveBeenCalled();
  });

  it("loop.refusal = null, summary has no JSON → fallback generateExecutionPlan fires", async () => {
    vi.mocked(runAgentLoop).mockResolvedValue(
      baseLoopResult({ refusal: null, summary: "I looked at the files but found nothing." })
    );
    const fakePlan = { objective: "fallback", steps: [] };
    vi.mocked(generateExecutionPlan).mockResolvedValue(fakePlan as never);

    const result = await runPlanInvestigation(BASE_INPUT);
    expect(generateExecutionPlan).toHaveBeenCalledOnce();
    expect(result.objective).toBe("fallback");
  });

  it("loop.refusal absent (undefined), summary has valid JSON → returns parsed plan, no fallback", async () => {
    const planJson = JSON.stringify({ objective: "add feature", steps: [{ title: "s1", filesLikely: [], description: "d", reproduceCommand: "echo", verifyCommand: "echo" }] });
    vi.mocked(runAgentLoop).mockResolvedValue(
      baseLoopResult({ summary: "```json\n" + planJson + "\n```" })
    );

    const result = await runPlanInvestigation(BASE_INPUT);
    expect(generateExecutionPlan).not.toHaveBeenCalled();
    expect(result.objective).toBe("add feature");
  });
});
