import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

import { generateExecutionPlan } from "./executionPlan.js";

function mockPlanResponse(plan: unknown) {
  mocks.createChatCompletion.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(plan) } }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateExecutionPlan — Q.3 subagent annotation", () => {
  it("preserves subagentEligible + subagentType=worker on multi-file fanout steps", async () => {
    mockPlanResponse({
      objective: "Rename helper foo to bar across the repo",
      steps: [
        {
          title: "Apply rename across handlers",
          description: "Find every occurrence of foo and replace with bar in all handler files.",
          filesLikely: ["src/api/handlers/a.ts", "src/api/handlers/b.ts", "src/api/handlers/c.ts"],
          subagentEligible: true,
          subagentType: "worker",
        },
        {
          title: "Update imports",
          description: "Update the import statements that referenced foo.",
          filesLikely: ["src/index.ts"],
        },
      ],
      riskHints: ["Missing call sites in tests"],
      scopeSummary: "Rename foo→bar in handlers + import sites.",
    });

    const plan = await generateExecutionPlan({
      task: "rename foo to bar",
      repoSummary: "small monorepo",
      relevantFiles: [],
    });

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].subagentEligible).toBe(true);
    expect(plan.steps[0].subagentType).toBe("worker");
    expect(plan.steps[1].subagentEligible).toBeUndefined();
    expect(plan.steps[1].subagentType).toBeUndefined();
  });

  it("preserves subagentType=explore on read-only investigation steps", async () => {
    mockPlanResponse({
      objective: "Identify usages of authService",
      steps: [
        {
          title: "Map all callers of authService",
          description: "Pure read-only investigation across the repo.",
          filesLikely: ["src/**/*.ts"],
          subagentEligible: true,
          subagentType: "explore",
        },
      ],
      riskHints: [],
      scopeSummary: "Investigation only.",
    });

    const plan = await generateExecutionPlan({
      task: "find all authService usages",
      repoSummary: "",
      relevantFiles: [],
    });

    expect(plan.steps[0].subagentType).toBe("explore");
    expect(plan.steps[0].subagentEligible).toBe(true);
  });

  it("omits annotation for trivial single-file steps", async () => {
    mockPlanResponse({
      objective: "Fix a typo",
      steps: [
        {
          title: "Correct the typo in README",
          description: "Replace 'teh' with 'the' on line 42.",
          filesLikely: ["README.md"],
        },
      ],
      riskHints: [],
      scopeSummary: "Single-line edit.",
    });

    const plan = await generateExecutionPlan({
      task: "fix README typo",
      repoSummary: "",
      relevantFiles: [],
    });

    expect(plan.steps[0].subagentEligible).toBeUndefined();
    expect(plan.steps[0].subagentType).toBeUndefined();
  });

  it("normalizes half-set annotation (eligible without type) to no annotation", async () => {
    mockPlanResponse({
      objective: "X",
      steps: [
        {
          title: "Step A",
          description: "Some step.",
          filesLikely: ["a.ts"],
          subagentEligible: true,
          // subagentType intentionally omitted
        },
      ],
      riskHints: [],
      scopeSummary: "S",
    });

    const plan = await generateExecutionPlan({
      task: "X",
      repoSummary: "",
      relevantFiles: [],
    });

    expect(plan.steps[0].subagentEligible).toBeUndefined();
    expect(plan.steps[0].subagentType).toBeUndefined();
  });

  it("normalizes type-without-eligible to no annotation", async () => {
    mockPlanResponse({
      objective: "X",
      steps: [
        {
          title: "Step A",
          description: "Some step.",
          filesLikely: ["a.ts"],
          subagentType: "worker",
          // subagentEligible intentionally omitted
        },
      ],
      riskHints: [],
      scopeSummary: "S",
    });

    const plan = await generateExecutionPlan({
      task: "X",
      repoSummary: "",
      relevantFiles: [],
    });

    expect(plan.steps[0].subagentEligible).toBeUndefined();
    expect(plan.steps[0].subagentType).toBeUndefined();
  });

  it("prompt instructs the model about subagent eligibility patterns", async () => {
    mockPlanResponse({
      objective: "X",
      steps: [{ title: "T", description: "D", filesLikely: ["x.ts"] }],
      riskHints: [],
      scopeSummary: "S",
    });

    await generateExecutionPlan({
      task: "task",
      repoSummary: "",
      relevantFiles: [],
    });

    const prompt = String(
      mocks.createChatCompletion.mock.calls[0]?.[0]?.messages?.[0]?.content ?? ""
    );
    expect(prompt).toContain("subagentEligible");
    expect(prompt).toContain("multi-file");
    expect(prompt.toLowerCase()).toContain("read-only");
  });
});
