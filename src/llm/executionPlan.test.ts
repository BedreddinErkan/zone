import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  debugLog: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

// Both names, not just debugLog: executionPlan.ts imports `log` too, and a mock
// missing it makes `log` undefined at call time rather than failing at import.
vi.mock("../utils/logger.js", () => ({
  debugLog: mocks.debugLog,
  log: mocks.log,
}));

import { generateExecutionPlan, tryParseExecutionPlan, isNoChangePlan, isCannotVerifyPlan, isAnswerOnlyPlan, planTerminalShape, formatExecutionPlanForPrompt, buildApprovedPlanBlock, formatPlanRevisedNote, synthesizeMinimalPlan } from "./executionPlan.js";
import type { ExecutionPlan } from "./executionPlan.js";
// buildPrompt is pure and synchronous (no LLM call) — real, unmocked import is safe here;
// this file mocks no part of planInvestigation.js.
import { buildPrompt } from "./planInvestigation.js";

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

describe("generateExecutionPlan — forceSteps prompt", () => {
  it("exclusion list names all three reason fields, not just the original two", async () => {
    mockPlanResponse({
      objective: "Add a helper",
      steps: [{ title: "T", description: "D", filesLikely: ["x.ts"] }],
      riskHints: [],
      scopeSummary: "S",
    });

    await generateExecutionPlan({
      task: "Add a helper function",
      repoSummary: "",
      relevantFiles: [],
      forceSteps: true,
    });

    const prompt = String(
      mocks.createChatCompletion.mock.calls[0]?.[0]?.messages?.[0]?.content ?? ""
    );
    expect(prompt).toContain("Do NOT set noChangeReason, cannotVerifyReason, or answerOnlyReason.");
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

describe("isAnswerOnlyPlan", () => {
  it("returns true for empty-steps plan with answerOnlyReason", () => {
    const plan = {
      objective: "Explain X",
      steps: [],
      riskHints: [],
      scopeSummary: "Answer only.",
      answerOnlyReason: "The task is a question; nothing needs to change.",
    };
    expect(isAnswerOnlyPlan(plan)).toBe(true);
  });

  it("returns false for normal plan with steps", () => {
    const plan = {
      objective: "Add feature",
      steps: [{ title: "Step 1", description: "Do it", filesLikely: ["src/x.ts"] }],
      riskHints: [],
      scopeSummary: "Feature.",
    };
    expect(isAnswerOnlyPlan(plan)).toBe(false);
  });
});

describe("planTerminalShape", () => {
  const STEP = { title: "Step", description: "Do the thing", filesLikely: ["src/x.ts"] };
  const BASE = { objective: "X", riskHints: [], scopeSummary: "S" };

  it('returns "steps" for a plan with real steps', () => {
    expect(planTerminalShape({ ...BASE, steps: [STEP] })).toBe("steps");
  });

  it('returns "no_change" for an empty-steps plan with noChangeReason', () => {
    expect(planTerminalShape({ ...BASE, steps: [], noChangeReason: "exits 0" })).toBe("no_change");
  });

  it('returns "cannot_verify" for an empty-steps plan with cannotVerifyReason', () => {
    expect(planTerminalShape({ ...BASE, steps: [], cannotVerifyReason: "did not run" })).toBe("cannot_verify");
  });

  it('returns "answer" for an empty-steps plan with answerOnlyReason', () => {
    expect(planTerminalShape({ ...BASE, steps: [], answerOnlyReason: "it's a question" })).toBe("answer");
  });

  it('returns "unknown" and emits [zone-plan-unknown-terminal-shape] for an empty-steps plan with no reason field at all', () => {
    // Only reachable via a hand-constructed object bypassing executionPlanSchema.parse —
    // the schema itself still rejects this combination (superRefine, unchanged).
    const result = planTerminalShape({ ...BASE, steps: [] });
    expect(result).toBe("unknown");
    const calls = mocks.log.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((s: string) => s.includes("[zone-plan-unknown-terminal-shape]"))).toBe(true);
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

  it("[zone-plan-salvaged] counter emitted via log (marker sink) on salvage", () => {
    tryParseExecutionPlan(
      wrapJson({ objective: "Fix", steps: [STEP], riskHints: [], scopeSummary: "S.", cannotVerifyReason: "did not run" })
    );
    const calls = mocks.log.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((s: string) => s.includes("[zone-plan-salvaged]") && s.includes("cannotVerifyReason"))).toBe(true);
    // Negative half: the old channel must be empty, or a future revert to
    // debugLog would leave this test green while the marker went dark again.
    const debugCalls = mocks.debugLog.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(debugCalls.some((s: string) => s.includes("[zone-plan-salvaged]"))).toBe(false);
  });

  it("regression: empty steps + neither reason → still null (branch 1 preserved)", () => {
    expect(tryParseExecutionPlan(wrapJson({ objective: "X", steps: [], riskHints: [], scopeSummary: "S" }))).toBeNull();
  });

  it("regression: empty steps + both reasons → still null (branch 2 preserved)", () => {
    expect(tryParseExecutionPlan(wrapJson({ objective: "X", steps: [], riskHints: [], scopeSummary: "S", noChangeReason: "ok", cannotVerifyReason: "blocked" }))).toBeNull();
  });

  it("empty steps + noChangeReason AND answerOnlyReason together → still null (2-of-3 rejected)", () => {
    expect(tryParseExecutionPlan(wrapJson({ objective: "X", steps: [], riskHints: [], scopeSummary: "S", noChangeReason: "ok", answerOnlyReason: "it's a question" }))).toBeNull();
  });

  it("generateExecutionPlan: steps + answerOnlyReason → parses without throw, field stripped", async () => {
    mockPlanResponse({
      objective: "Explain X",
      steps: [STEP],
      riskHints: [],
      scopeSummary: "Explain.",
      answerOnlyReason: "The task is a question.",
    });

    const plan = await generateExecutionPlan({ task: "explain", repoSummary: "", relevantFiles: [] });

    expect(plan.steps).toHaveLength(1);
    expect(plan.answerOnlyReason).toBeUndefined();
  });

  it("tryParseExecutionPlan: steps + answerOnlyReason → salvaged plan (not null)", () => {
    const result = tryParseExecutionPlan(
      wrapJson({ objective: "Explain", steps: [STEP], riskHints: [], scopeSummary: "S.", answerOnlyReason: "it's a question" })
    );
    expect(result).not.toBeNull();
    expect(result!.answerOnlyReason).toBeUndefined();
    expect(result!.steps).toHaveLength(1);
  });

  it("regression: clean plan → unchanged, no salvage marker emitted", () => {
    const result = tryParseExecutionPlan(wrapJson({ objective: "Fix", steps: [STEP], riskHints: [], scopeSummary: "S." }));
    expect(result).not.toBeNull();
    const salvagedCalls = mocks.log.mock.calls.filter((c: unknown[]) => String(c[0]).includes("[zone-plan-salvaged]"));
    expect(salvagedCalls).toHaveLength(0);
  });
});

describe("[zone-plan-field-over-advisory-cap]", () => {
  // Local copies — the sibling describes each scope their own; none is module-level.
  const STEP = { title: "Step", description: "Do the thing", filesLikely: ["src/x.ts"] };
  function wrapJson(obj: unknown): string {
    return "```json\n" + JSON.stringify(obj) + "\n```";
  }

  function overrunCalls(): Array<Record<string, unknown>> {
    return mocks.log.mock.calls
      .filter((c: unknown[]) => c[0] === "[zone-plan-field-over-advisory-cap]")
      .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);
  }

  it("fires for scopeNotes past its 200-char advisory cap, carrying field/length/cap", () => {
    const notes = "n".repeat(1050); // the length a real answer-only run actually produced
    tryParseExecutionPlan(
      wrapJson({ objective: "X", steps: [STEP], riskHints: [], scopeSummary: "S", scopeNotes: notes })
    );
    expect(overrunCalls()).toHaveLength(1);
    expect(overrunCalls()[0]).toMatchObject({ field: "scopeNotes", length: 1050, cap: 200 });
  });

  it("fires for scopeSummary past its own 160-char cap", () => {
    tryParseExecutionPlan(
      wrapJson({ objective: "X", steps: [STEP], riskHints: [], scopeSummary: "s".repeat(161) })
    );
    expect(overrunCalls()[0]).toMatchObject({ field: "scopeSummary", length: 161, cap: 160 });
  });

  it("stays silent when both fields are within their caps — the cap is the trigger, not the field's presence", () => {
    tryParseExecutionPlan(
      wrapJson({
        objective: "X", steps: [STEP], riskHints: [],
        scopeSummary: "s".repeat(160), scopeNotes: "n".repeat(200), // exactly at cap, not over
      })
    );
    expect(overrunCalls()).toHaveLength(0);
  });
});

describe("synthesizeMinimalPlan — [zone-plan-synthesized]", () => {
  function synthesizedCalls(): Array<Record<string, unknown>> {
    return mocks.log.mock.calls
      .filter((c: unknown[]) => c[0] === "[zone-plan-synthesized]")
      .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);
  }

  it("emits via log (the marker sink channel), not debugLog", () => {
    synthesizeMinimalPlan("Add a helper to src/utils/dates.ts", []);
    expect(synthesizedCalls()).toHaveLength(1);
    const debugCalls = mocks.debugLog.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("[zone-plan-synthesized]")
    );
    expect(debugCalls).toHaveLength(0);
  });

  it("payload carries taskLength, filesLikelyCount and the preceding throw reason", () => {
    const task = "Add a helper to src/utils/dates.ts";
    synthesizeMinimalPlan(task, ["src/other.ts"], "generateExecutionPlan: no steps returned (forceSteps)");
    const [payload] = synthesizedCalls();
    expect(payload).toMatchObject({
      taskLength: task.length,
      // src/utils/dates.ts scraped from the task text + src/other.ts from relevantFiles
      filesLikelyCount: 2,
      forceStepsFailReason: "generateExecutionPlan: no steps returned (forceSteps)",
    });
  });

  it("reason is null, not absent, when no throw preceded the fallback", () => {
    synthesizeMinimalPlan("Add a helper", []);
    const [payload] = synthesizedCalls();
    expect(payload).toHaveProperty("forceStepsFailReason", null);
  });
});

describe("formatExecutionPlanForPrompt", () => {
  const BASE_PLAN: ExecutionPlan = {
    objective: "Add a login feature",
    steps: [
      { title: "Add login route", description: "Create the route", filesLikely: ["src/routes/login.ts"] },
    ],
    riskHints: [],
    scopeSummary: "Add a login feature end to end.",
  };

  it("returns an empty string when no plan is given", () => {
    expect(formatExecutionPlanForPrompt(undefined)).toBe("");
    expect(formatExecutionPlanForPrompt(null)).toBe("");
  });

  it("renders objective, steps, and scope unchanged when riskHints is empty", () => {
    const text = formatExecutionPlanForPrompt(BASE_PLAN);
    // Content checks, not label-shape checks: a relabel of "Objective:"/"Scope:" should
    // not fail this suite, only losing the content itself should. The old fused
    // step-line assertion (numbering + separator + "(files: ...)" suffix in one string)
    // is split into three independent checks for the same reason — each field is
    // independently provable rather than one string pinning shape and content together.
    expect(text).toContain("Add a login feature");
    expect(text).toContain("Add login route");
    expect(text).toContain("Create the route");
    expect(text).toContain("src/routes/login.ts");
    expect(text).toContain("Add a login feature end to end.");
    expect(text).not.toContain("Risks:");
  });

  it("appends a Risks: section listing every riskHint when present", () => {
    const plan: ExecutionPlan = { ...BASE_PLAN, riskHints: ["Might break auth middleware", "Touches shared config"] };
    const text = formatExecutionPlanForPrompt(plan);
    expect(text).toContain("Risks:");
    expect(text).toContain("- Might break auth middleware");
    expect(text).toContain("- Touches shared config");
  });

  it("does not render a Risks: label when riskHints is empty (no dangling header)", () => {
    const text = formatExecutionPlanForPrompt({ ...BASE_PLAN, riskHints: [] });
    expect(text).not.toContain("Risks:");
  });

  it("omits the (files: ...) suffix entirely for a step with no likely files — no 'unknown' placeholder", () => {
    const plan: ExecutionPlan = {
      ...BASE_PLAN,
      steps: [{ title: "Investigate the gap", description: "A step whose likely files were never determined during planning.", filesLikely: [] }],
    };
    const text = formatExecutionPlanForPrompt(plan);
    expect(text).toContain("A step whose likely files were never determined during planning.");
    expect(text).not.toContain("(files:");
    expect(text).not.toContain("unknown");
  });

  // The two expects below are deliberately two separate `it`s, not two expects in one —
  // vitest halts a test body at its first failing expect, so a single combined test can
  // only ever report "the header assertion failed," even on a mutation that drops the
  // header but leaves the content intact. Splitting them means a mutation that removes
  // only the header (content survives) and one that removes everything (content also
  // gone) produce genuinely different, observable kill sets rather than looking identical
  // because the second expect never got the chance to run.
  it("scopeNotes present — the Caveats: header appears", () => {
    const plan: ExecutionPlan = { ...BASE_PLAN, scopeNotes: "Only the read_file catch path was investigated; the write_file catch was not examined and may have the same gap." };
    const text = formatExecutionPlanForPrompt(plan);
    expect(text).toContain("Caveats:");
  });

  it("scopeNotes present — the note's own content reaches the output", () => {
    const plan: ExecutionPlan = { ...BASE_PLAN, scopeNotes: "Only the read_file catch path was investigated; the write_file catch was not examined and may have the same gap." };
    const text = formatExecutionPlanForPrompt(plan);
    expect(text).toContain("Only the read_file catch path was investigated; the write_file catch was not examined and may have the same gap.");
  });

  it("scopeNotes absent — no Caveats: header (no dangling header, same principle as Risks)", () => {
    // "Caveats:" grep-verified unique against every fixture string in this describe
    // block before writing this assertion — an absence check is only meaningful if
    // nothing else could produce a coincidental match.
    const text = formatExecutionPlanForPrompt(BASE_PLAN);
    expect(text).not.toContain("Caveats:");
  });

  it("a plan carrying every optional field renders all of them — one silently dropped field would be visible here", () => {
    const plan: ExecutionPlan = {
      objective: "Rename the legacy config loader",
      steps: [
        { title: "Update the loader export", description: "Switch the default export to the renamed function", filesLikely: ["src/config/loader.ts"] },
      ],
      riskHints: ["Downstream importers using the old export name will break at compile time."],
      scopeSummary: "Touches only the config module and its direct importers.",
      scopeNotes: "The importer list was generated from a grep, not a type-level check, so an importer using a dynamic require would be missed.",
    };
    const text = formatExecutionPlanForPrompt(plan);
    expect(text).toContain("Rename the legacy config loader");
    expect(text).toContain("Touches only the config module and its direct importers.");
    expect(text).toContain("Update the loader export");
    expect(text).toContain("Switch the default export to the renamed function");
    expect(text).toContain("src/config/loader.ts");
    expect(text).toContain("Downstream importers using the old export name will break at compile time.");
    expect(text).toContain("The importer list was generated from a grep, not a type-level check, so an importer using a dynamic require would be missed.");
  });
});

describe("buildApprovedPlanBlock", () => {
  const PLAN: ExecutionPlan = {
    objective: "Add a login feature",
    steps: [{ title: "Add login route", description: "Create the route", filesLikely: [] }],
    riskHints: [],
    scopeSummary: "Add a login feature end to end.",
  };

  it("wraps formatExecutionPlanForPrompt's output with header and footer", () => {
    const block = buildApprovedPlanBlock(PLAN);
    expect(block).toContain("--- APPROVED PLAN ---");
    expect(block).toContain("--- END APPROVED PLAN ---");
    expect(block).toContain("Objective: Add a login feature");
  });
});

describe("formatPlanRevisedNote", () => {
  const PLAN: ExecutionPlan = {
    objective: "Revised objective",
    steps: [
      { title: "Step A", description: "Do A", filesLikely: [] },
      { title: "Step B", description: "Do B", filesLikely: [] },
    ],
    riskHints: [],
    scopeSummary: "Revised scope.",
  };

  it("leads with a step-count summary line and includes the full plan content", () => {
    const note = formatPlanRevisedNote(PLAN);
    expect(note.startsWith("Plan revised — 2 steps.")).toBe(true);
    expect(note).toContain("Objective: Revised objective");
    expect(note).toContain("Revised scope.");
  });
});

// Removed instructions ("concise", "briefly", the two advisory-cap statements, the
// "short approach"/"1-3 sentences" clauses) vs. kept ones (the caps' own overrun marker
// stays untouched — see the [zone-plan-field-over-advisory-cap] describe above — "concrete",
// the title-restatement clause, "Return JSON only", "Identify risks", and the investigation
// template's own iteration-budget instruction). docs/deferred-work.md item 78.
//
// Absence assertions below deliberately avoid bare digits ("160"/"200"): a number can
// appear in a built prompt for reasons that have nothing to do with the cap it used to
// state (seeded file content, a path, a count elsewhere), so not.toContain on a bare
// digit is fragile in the direction of a false failure. Each absence check below targets
// a multi-word (or word+symbol) phrase unique to the removed clause, verified unique via
// grep before use. Presence assertions don't need the same care — a distinctive phrase
// being present is a strong signal on its own, since nothing else in either prompt would
// produce it by coincidence. That asymmetry (absence needs a precise target; presence
// tolerates a looser one) is why the two halves below are built differently.
async function buildLexicalPrompt(overrides: {
  seededFileContents?: string;
} = {}): Promise<string> {
  mocks.createChatCompletion.mockResolvedValueOnce({
    choices: [{
      message: {
        content: JSON.stringify({
          objective: "X",
          steps: [{ title: "T", description: "D", filesLikely: [] }],
          riskHints: [],
          scopeSummary: "S",
        }),
      },
    }],
  });
  await generateExecutionPlan({
    task: "add a helper",
    repoSummary: "a webapp",
    relevantFiles: ["src/a.ts"],
    ...overrides,
  });
  return String(mocks.createChatCompletion.mock.calls[0]?.[0]?.messages?.[0]?.content ?? "");
}

describe("plan-generation prompts — brevity instructions removed, caps lifted (item 78)", () => {
  it("lexical template, unseeded: removed wording and the scopeSummary cap are absent", async () => {
    const prompt = await buildLexicalPrompt();
    expect(prompt).not.toContain("concise");
    expect(prompt).not.toContain("briefly");
    expect(prompt).not.toContain("short approach");
    expect(prompt).not.toContain("1-3 sentences");
    expect(prompt).not.toContain("scopeSummary under");
  });

  it("lexical template, seeded: the scopeNotes cap is absent, the no-padding guard survives", async () => {
    const prompt = await buildLexicalPrompt({ seededFileContents: "=== src/a.ts ===\nconst x = 1;\n" });
    expect(prompt).not.toContain("scopeNotes ≤");
    expect(prompt).toContain("Omit if nothing notable");
    expect(prompt).toContain("already implemented");
  });

  it("lexical template: kept instructions survive — the discriminating half, since a mutation deleting the whole Rules block would still pass every absence check above", async () => {
    const prompt = await buildLexicalPrompt();
    expect(prompt).toContain("concrete, not a restatement of the title");
    expect(prompt).toContain("Return JSON only");
    expect(prompt).toContain("Identify risks");
  });

  it("investigation template: removed wording and both caps are absent", () => {
    const prompt = buildPrompt("add a helper", ["src/a.ts"], true);
    expect(prompt).not.toContain('"scopeSummary": "string (≤');
    expect(prompt).not.toContain("optional, ≤");
    expect(prompt).not.toContain("short approach");
    expect(prompt).not.toContain("1-3 sentences");
  });

  it("investigation template: kept instructions survive, including the out-of-scope iteration-budget instruction", () => {
    const prompt = buildPrompt("add a helper", ["src/a.ts"], true);
    expect(prompt).toContain("concrete, not a restatement of the title");
    expect(prompt).toContain("already done / out of scope");
    expect(prompt).toContain("Terminate as soon as you have enough information");
    expect(prompt).toContain("do not over-investigate");
  });

  it("the two templates' description field spec are identical — nothing else in this suite compares them to each other", async () => {
    const lexicalPrompt = await buildLexicalPrompt();
    const investigationPrompt = buildPrompt("add a helper", ["src/a.ts"], true);
    const DESC_SPEC_RE = /"description":\s*"(<[^"]*>)"/;
    const lexicalSpec = DESC_SPEC_RE.exec(lexicalPrompt)?.[1];
    const investigationSpec = DESC_SPEC_RE.exec(investigationPrompt)?.[1];
    expect(lexicalSpec).toBeDefined();
    expect(lexicalSpec).toBe(investigationSpec);
  });
});
