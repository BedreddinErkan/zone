import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../utils/logger.js", () => ({
  debugLog: mocks.debugLog,
}));

import { generateExecutionPlan, tryParseExecutionPlan, isNoChangePlan, isCannotVerifyPlan } from "./executionPlan.js";

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

  it("returns null when steps array is empty without noChangeReason (superRefine rejects)", () => {
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

// E4: noChangeReason / isNoChangePlan — reproduce-first honest outcome
describe("E4: noChangeReason / isNoChangePlan", () => {
  const VALID_PLAN = {
    objective: "Add pagination",
    steps: [{ title: "Update UI", description: "Add buttons", filesLikely: ["src/ui.ts"] }],
    riskHints: [],
    scopeSummary: "Add pagination UI.",
  };

  function wrapJson(obj: unknown): string {
    return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
  }

  it("tryParseExecutionPlan: empty steps WITH noChangeReason parses successfully", () => {
    const noChangePlan = {
      objective: "Verify build",
      steps: [],
      riskHints: [],
      scopeSummary: "No changes needed.",
      noChangeReason: "npm run build exits 0 — no error to fix",
    };
    const result = tryParseExecutionPlan(wrapJson(noChangePlan));
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(0);
    expect(result!.noChangeReason).toBe("npm run build exits 0 — no error to fix");
  });

  it("tryParseExecutionPlan: empty steps WITHOUT noChangeReason returns null (superRefine rejects)", () => {
    const bad = { objective: "X", steps: [], riskHints: [], scopeSummary: "S" };
    expect(tryParseExecutionPlan(wrapJson(bad))).toBeNull();
  });

  it("non-empty steps WITH noChangeReason → salvaged: noChangeReason stripped, steps intact", () => {
    const bad = { ...VALID_PLAN, noChangeReason: "build exits 0" };
    const result = tryParseExecutionPlan(wrapJson(bad));
    expect(result).not.toBeNull();
    expect(result!.noChangeReason).toBeUndefined();
    expect(result!.steps).toHaveLength(1);
  });

  it("isNoChangePlan: returns true for empty-steps plan with noChangeReason", () => {
    const plan = {
      objective: "Verify",
      steps: [],
      riskHints: [],
      scopeSummary: "No change.",
      noChangeReason: "build exits 0",
    };
    expect(isNoChangePlan(plan)).toBe(true);
  });

  it("isNoChangePlan: returns false for normal plan with steps", () => {
    const plan = {
      objective: "Add feature",
      steps: [{ title: "Step 1", description: "Do it", filesLikely: ["src/x.ts"] }],
      riskHints: [],
      scopeSummary: "Feature.",
    };
    expect(isNoChangePlan(plan)).toBe(false);
  });
});

// S3: cannotVerifyReason / isCannotVerifyPlan — reproduce command did not run
describe("S3: cannotVerifyReason / isCannotVerifyPlan", () => {
  function wrapJson(obj: unknown): string {
    return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
  }

  it("empty steps WITH cannotVerifyReason parses successfully", () => {
    const plan = {
      objective: "Verify build",
      steps: [],
      riskHints: [],
      scopeSummary: "Could not verify.",
      cannotVerifyReason: "Could not verify — npm run build did not run (auto-denied); premise unconfirmed.",
    };
    const result = tryParseExecutionPlan(wrapJson(plan));
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(0);
    expect(result!.cannotVerifyReason).toContain("did not run");
  });

  it("empty steps WITH BOTH noChangeReason AND cannotVerifyReason → null (XOR violated)", () => {
    const plan = {
      objective: "X",
      steps: [],
      riskHints: [],
      scopeSummary: "S",
      noChangeReason: "exits 0",
      cannotVerifyReason: "did not run",
    };
    expect(tryParseExecutionPlan(wrapJson(plan))).toBeNull();
  });

  it("non-empty steps WITH cannotVerifyReason → salvaged: cannotVerifyReason stripped, steps intact", () => {
    const plan = {
      objective: "Fix",
      steps: [{ title: "Step", description: "Do", filesLikely: ["src/x.ts"] }],
      riskHints: [],
      scopeSummary: "Fix.",
      cannotVerifyReason: "did not run",
    };
    const result = tryParseExecutionPlan(wrapJson(plan));
    expect(result).not.toBeNull();
    expect(result!.cannotVerifyReason).toBeUndefined();
    expect(result!.steps).toHaveLength(1);
  });

  it("isCannotVerifyPlan: returns true for empty-steps plan with cannotVerifyReason", () => {
    const plan = {
      objective: "Verify",
      steps: [],
      riskHints: [],
      scopeSummary: "Could not verify.",
      cannotVerifyReason: "Command blocked.",
    };
    expect(isCannotVerifyPlan(plan)).toBe(true);
  });

  it("isCannotVerifyPlan: returns false for normal plan with steps", () => {
    const plan = {
      objective: "Fix feature",
      steps: [{ title: "Step 1", description: "Do it", filesLikely: ["src/x.ts"] }],
      riskHints: [],
      scopeSummary: "Feature.",
    };
    expect(isCannotVerifyPlan(plan)).toBe(false);
  });

  it("isCannotVerifyPlan: returns false for noChange plan (wrong field)", () => {
    const plan = {
      objective: "Verify",
      steps: [],
      riskHints: [],
      scopeSummary: "No change.",
      noChangeReason: "exits 0",
    };
    expect(isCannotVerifyPlan(plan)).toBe(false);
  });
});

// Schema salvage — superRefine branch 3 dropped, transform strips reason fields
describe("executionPlanSchema salvage — steps + reason", () => {
  const STEP = { title: "Step", description: "Do the thing", filesLikely: ["src/x.ts"] };

  function wrapJson(obj: unknown): string {
    return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
  }

  function mockPlanResponse(plan: unknown) {
    mocks.createChatCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(plan) } }],
    });
  }

  it("generateExecutionPlan: steps + cannotVerifyReason → parses without throw, field stripped", async () => {
    mockPlanResponse({
      objective: "Fix the error",
      steps: [STEP],
      riskHints: [],
      scopeSummary: "Fix.",
      cannotVerifyReason: "Command did not run — auto-denied.",
    });

    const plan = await generateExecutionPlan({ task: "fix", repoSummary: "", relevantFiles: [] });

    expect(plan.steps).toHaveLength(1);
    expect(plan.cannotVerifyReason).toBeUndefined();
  });

  it("tryParseExecutionPlan: steps + cannotVerifyReason → salvaged plan (not null)", () => {
    const result = tryParseExecutionPlan(
      wrapJson({ objective: "Fix", steps: [STEP], riskHints: [], scopeSummary: "S.", cannotVerifyReason: "did not run" })
    );
    expect(result).not.toBeNull();
    expect(result!.cannotVerifyReason).toBeUndefined();
    expect(result!.steps).toHaveLength(1);
  });

  it("tryParseExecutionPlan: steps + noChangeReason → salvaged plan (not null)", () => {
    const result = tryParseExecutionPlan(
      wrapJson({ objective: "Fix", steps: [STEP], riskHints: [], scopeSummary: "S.", noChangeReason: "exits 0" })
    );
    expect(result).not.toBeNull();
    expect(result!.noChangeReason).toBeUndefined();
    expect(result!.steps).toHaveLength(1);
  });

  it("[zone-plan-salvaged] counter emitted via debugLog on salvage", () => {
    tryParseExecutionPlan(
      wrapJson({ objective: "Fix", steps: [STEP], riskHints: [], scopeSummary: "S.", cannotVerifyReason: "did not run" })
    );
    const calls = mocks.debugLog.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((s: string) => s.includes("[zone-plan-salvaged]") && s.includes("cannotVerifyReason"))).toBe(true);
  });

  it("regression: empty steps + neither reason → still null (branch 1 preserved)", () => {
    expect(tryParseExecutionPlan(wrapJson({ objective: "X", steps: [], riskHints: [], scopeSummary: "S" }))).toBeNull();
  });

  it("regression: empty steps + both reasons → still null (branch 2 preserved)", () => {
    expect(tryParseExecutionPlan(wrapJson({ objective: "X", steps: [], riskHints: [], scopeSummary: "S", noChangeReason: "ok", cannotVerifyReason: "blocked" }))).toBeNull();
  });

  it("regression: clean plan → unchanged, debugLog not called for salvage", () => {
    const result = tryParseExecutionPlan(wrapJson({ objective: "Fix", steps: [STEP], riskHints: [], scopeSummary: "S." }));
    expect(result).not.toBeNull();
    const salvagedCalls = mocks.debugLog.mock.calls.filter((c: unknown[]) => String(c[0]).includes("[zone-plan-salvaged]"));
    expect(salvagedCalls).toHaveLength(0);
  });
});
