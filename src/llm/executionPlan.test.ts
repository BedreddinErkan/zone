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

import { generateExecutionPlan, tryParseExecutionPlan } from "./executionPlan.js";

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

  it("Q.6: infers subagentType=worker when eligible:true is set without a type", async () => {
    mockPlanResponse({
      objective: "X",
      steps: [
        {
          title: "Step A",
          description: "Some step.",
          filesLikely: ["a.ts", "b.ts", "c.ts"],
          subagentEligible: true,
          // subagentType intentionally omitted — Q.6 relaxes Q.3 strict drop
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

    expect(plan.steps[0].subagentEligible).toBe(true);
    expect(plan.steps[0].subagentType).toBe("worker");
  });

  it("Q.6: infers subagentEligible=true when only subagentType is set", async () => {
    mockPlanResponse({
      objective: "X",
      steps: [
        {
          title: "Step A",
          description: "Some step.",
          filesLikely: ["a.ts", "b.ts", "c.ts"],
          subagentType: "worker",
          // subagentEligible intentionally omitted — type implies intent
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

    expect(plan.steps[0].subagentEligible).toBe(true);
    expect(plan.steps[0].subagentType).toBe("worker");
  });

  it("Q.6: explicit subagentEligible=false drops both fields even when type is set", async () => {
    mockPlanResponse({
      objective: "X",
      steps: [
        {
          title: "Step A",
          description: "Explicit opt-out from delegation.",
          filesLikely: ["a.ts"],
          subagentEligible: false,
          subagentType: "worker",
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
    // Q.6: prompt must include concrete in-prompt examples
    expect(prompt).toContain("EXAMPLE A");
    expect(prompt).toContain("EXAMPLE B");
    expect(prompt).toContain("EXAMPLE C");
    expect(prompt.toLowerCase()).toContain("when in doubt");
  });
});

// Phase 2a: Option B — seeded file contents + scopeNotes
describe("generateExecutionPlan — seededFileContents + scopeNotes", () => {
  it("seededFileContents is included in the prompt when provided", async () => {
    mockPlanResponse({
      objective: "Add pagination",
      steps: [{ title: "Add UI", description: "Add buttons", filesLikely: ["src/ui.ts"] }],
      riskHints: [],
      scopeSummary: "Add pagination UI.",
    });

    await generateExecutionPlan({
      task: "add pagination",
      repoSummary: "webapp",
      relevantFiles: ["src/ui.ts"],
      seededFileContents: "=== src/ui.ts ===\nconst x = 1;\n",
    });

    const prompt = String(
      mocks.createChatCompletion.mock.calls[0]?.[0]?.messages?.[0]?.content ?? ""
    );
    expect(prompt).toContain("SEEDED FILE CONTENTS");
    expect(prompt).toContain("=== src/ui.ts ===");
    expect(prompt).toContain("const x = 1;");
  });

  it("scopeNotes rule is injected into prompt when seededFileContents is provided", async () => {
    mockPlanResponse({
      objective: "Fix auth",
      steps: [{ title: "Fix token", description: "Update token", filesLikely: ["src/auth.ts"] }],
      riskHints: [],
      scopeSummary: "Fix auth token.",
    });

    await generateExecutionPlan({
      task: "fix auth",
      repoSummary: "app",
      relevantFiles: [],
      seededFileContents: "=== src/auth.ts ===\ntoken handling here",
    });

    const prompt = String(
      mocks.createChatCompletion.mock.calls[0]?.[0]?.messages?.[0]?.content ?? ""
    );
    expect(prompt).toContain("scopeNotes");
    expect(prompt.toLowerCase()).toContain("already implemented");
  });

  it("seededFileContents is absent from prompt when not provided", async () => {
    mockPlanResponse({
      objective: "Refactor",
      steps: [{ title: "Refactor", description: "Clean up", filesLikely: ["src/x.ts"] }],
      riskHints: [],
      scopeSummary: "Refactor.",
    });

    await generateExecutionPlan({
      task: "refactor",
      repoSummary: "codebase",
      relevantFiles: [],
    });

    const prompt = String(
      mocks.createChatCompletion.mock.calls[0]?.[0]?.messages?.[0]?.content ?? ""
    );
    expect(prompt).not.toContain("SEEDED FILE CONTENTS");
  });

  it("scopeNotes from LLM response is returned in the plan", async () => {
    mockPlanResponse({
      objective: "Add pagination",
      steps: [{ title: "Add UI", description: "Buttons", filesLikely: ["src/ui.ts"] }],
      riskHints: [],
      scopeSummary: "Scope.",
      scopeNotes: "Pagination backend already exists in src/api.ts",
    });

    const plan = await generateExecutionPlan({
      task: "add pagination",
      repoSummary: "webapp",
      relevantFiles: [],
      seededFileContents: "=== src/api.ts ===\nfunction paginate() {}",
    });

    expect(plan.scopeNotes).toBe("Pagination backend already exists in src/api.ts");
  });

  it("scopeNotes is undefined when LLM response omits it", async () => {
    mockPlanResponse({
      objective: "Fix bug",
      steps: [{ title: "Fix", description: "Fix it", filesLikely: ["src/x.ts"] }],
      riskHints: [],
      scopeSummary: "Fix.",
      // no scopeNotes field
    });

    const plan = await generateExecutionPlan({
      task: "fix bug",
      repoSummary: "codebase",
      relevantFiles: [],
    });

    expect(plan.scopeNotes).toBeUndefined();
  });
});

// Phase 2b: tryParseExecutionPlan
describe("tryParseExecutionPlan", () => {
  const VALID_PLAN = {
    objective: "Add pagination",
    steps: [{ title: "Update UI", description: "Add buttons", filesLikely: ["src/ui.ts"] }],
    riskHints: [],
    scopeSummary: "Add pagination UI.",
  };

  function wrapJson(obj: unknown): string {
    return `Some investigation text.\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\nEnd of response.`;
  }

  it("extracts a valid ExecutionPlan from a ```json block", () => {
    const result = tryParseExecutionPlan(wrapJson(VALID_PLAN));
    expect(result).not.toBeNull();
    expect(result!.objective).toBe("Add pagination");
    expect(result!.steps).toHaveLength(1);
  });

  it("returns null when no ```json block is present", () => {
    expect(tryParseExecutionPlan("No JSON here.")).toBeNull();
  });

  it("returns null when JSON is invalid", () => {
    expect(tryParseExecutionPlan("```json\n{not valid json}\n```")).toBeNull();
  });

  it("returns null when Zod schema validation fails (missing required fields)", () => {
    const bad = { objective: "X" }; // missing steps, riskHints, scopeSummary
    expect(tryParseExecutionPlan(wrapJson(bad))).toBeNull();
  });

  it("returns null when steps array is empty (schema requires min 1)", () => {
    const bad = { objective: "X", steps: [], riskHints: [], scopeSummary: "S" };
    expect(tryParseExecutionPlan(wrapJson(bad))).toBeNull();
  });

  it("extracts scopeNotes when present in the JSON", () => {
    const withScope = { ...VALID_PLAN, scopeNotes: "Auth module 80% done" };
    const result = tryParseExecutionPlan(wrapJson(withScope));
    expect(result!.scopeNotes).toBe("Auth module 80% done");
  });

  it("scopeNotes is absent when not in JSON", () => {
    const result = tryParseExecutionPlan(wrapJson(VALID_PLAN));
    expect(result!.scopeNotes).toBeUndefined();
  });

  it("uses the LAST ```json block when multiple are present", () => {
    const first = wrapJson({ ...VALID_PLAN, objective: "First plan" });
    const second = wrapJson({ ...VALID_PLAN, objective: "Second plan" });
    const combined = `${first}\n${second}`;
    const result = tryParseExecutionPlan(combined);
    expect(result!.objective).toBe("Second plan");
  });

  it("applies Q.6 normalization: infers subagentEligible from subagentType", () => {
    const withType = {
      ...VALID_PLAN,
      steps: [{ ...VALID_PLAN.steps[0], subagentType: "worker" }],
    };
    const result = tryParseExecutionPlan(wrapJson(withType));
    expect(result!.steps[0].subagentEligible).toBe(true);
    expect(result!.steps[0].subagentType).toBe("worker");
  });
});
