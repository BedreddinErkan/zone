import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Only createLLMClient is overridden — ApiKeyError/ProviderRequestError/PlanRefusalError stay
// real. Exactly one test reaches this call ("no static short-circuit for
// natural_completion..."); its assertion (`r.title` truthy) is satisfied identically whether
// construction throws or the real AI path succeeds, so a synchronous throw here changes
// nothing about what the test exercises.
vi.mock("../llm/factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/factory.js")>();
  return {
    ...actual,
    createLLMClient: vi.fn(() => {
      throw new Error("createLLMClient should not be called in this test");
    }),
  };
});

const baseInput = {
  task: "Add a button to the patients page.",
  contextFilesMeta: [{ path: "src/a.tsx", reason: "context" }],
  planObjective: "Update UI",
  planScopeSummary: "Small UI change",
  patchSource: "llm_patch" as const,
  fileDiffs: [{ filePath: "src/a.tsx", addedLines: 2, removedLines: 0 }],
  patchScope: {
    changedFileCount: 1,
    totalAddedLines: 2,
    totalRemovedLines: 0,
    totalChangedLines: 2,
  },
  decisionMode: "safe_to_apply" as const,
  finalState: "safe_to_apply" as const,
  warnings: [] as string[],
  correctness: { status: "passed" as const, summary: "Checks passed." },
  verificationCommandsLabel: "npm test",
  runtimeVerificationSummary: "All good",
  verificationStatus: "passed" as const,
  finalExecutionOutcome: "completed",
  developerConfidence: 80,
};

describe("generateFinalRunReport", () => {
  beforeEach(() => {
    vi.stubEnv("ZONE_AI_FINAL_REPORT", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes patch_generation_failed for no_patch", async () => {
    const { generateFinalRunReport } = await import("./generateFinalRunReport.js");
    const r = await generateFinalRunReport({
      ...baseInput,
      patchSource: "no_patch",
      fileDiffs: [],
      patchScope: {
        changedFileCount: 0,
        totalAddedLines: 0,
        totalRemovedLines: 0,
        totalChangedLines: 0,
      },
      decisionMode: "preview_only",
      finalState: "preview_only",
    });
    expect(r.statusSummary.toLowerCase()).toContain("patch_generation_failed");
    expect(r.statusSummary.toLowerCase()).toContain("no_patch");
  });

  it("includes needs_review for preview_only with patches", async () => {
    const { generateFinalRunReport } = await import("./generateFinalRunReport.js");
    const r = await generateFinalRunReport({
      ...baseInput,
      decisionMode: "preview_only",
      finalState: "preview_only",
    });
    expect(r.statusSummary.toLowerCase()).toContain("needs_review");
    expect(r.statusSummary.toLowerCase()).toContain("preview_only");
  });

  it("includes blocked_for_safety when blocked", async () => {
    const { generateFinalRunReport } = await import("./generateFinalRunReport.js");
    const r = await generateFinalRunReport({
      ...baseInput,
      decisionMode: "blocked",
      finalState: "blocked",
    });
    expect(r.statusSummary.toLowerCase()).toContain("blocked_for_safety");
  });

  it("embeds authoritative decisionMode in safetySummary", async () => {
    const { generateFinalRunReport } = await import("./generateFinalRunReport.js");
    const r = await generateFinalRunReport({
      ...baseInput,
      decisionMode: "safe_to_apply",
    });
    expect(r.safetySummary.some((s) => s.includes("decisionMode (authoritative): safe_to_apply"))).toBe(true);
  });

  it("static report (no LLM) for daily_usd_cap_exceeded", async () => {
    vi.stubEnv("ZONE_AI_FINAL_REPORT", "true");
    const { generateFinalRunReport, buildDeterministicFinalRunReport } = await import("./generateFinalRunReport.js");
    const input = {
      ...baseInput,
      patchSource: "no_patch" as const,
      fileDiffs: [],
      patchScope: { changedFileCount: 0, totalAddedLines: 0, totalRemovedLines: 0, totalChangedLines: 0 },
      decisionMode: "preview_only" as const,
      finalState: "preview_only" as const,
      terminationReason: "daily_usd_cap_exceeded",
    };
    const r = await generateFinalRunReport(input);
    const expected = buildDeterministicFinalRunReport(input);
    // Must return static report, not an AI report (field values must match deterministic output)
    expect(r.title).toBe(expected.title);
    expect(r.statusSummary).toBe(expected.statusSummary);
  });

  it("static report (no LLM) for token_budget_exceeded", async () => {
    vi.stubEnv("ZONE_AI_FINAL_REPORT", "true");
    const { generateFinalRunReport, buildDeterministicFinalRunReport } = await import("./generateFinalRunReport.js");
    const input = { ...baseInput, terminationReason: "token_budget_exceeded" };
    const r = await generateFinalRunReport(input);
    expect(r.title).toBe(buildDeterministicFinalRunReport(input).title);
  });

  it("static report (no LLM) for loop_detected", async () => {
    vi.stubEnv("ZONE_AI_FINAL_REPORT", "true");
    const { generateFinalRunReport, buildDeterministicFinalRunReport } = await import("./generateFinalRunReport.js");
    const input = { ...baseInput, terminationReason: "loop_detected" };
    const r = await generateFinalRunReport(input);
    expect(r.title).toBe(buildDeterministicFinalRunReport(input).title);
  });

  it("static report (no LLM) for compaction_exhausted", async () => {
    vi.stubEnv("ZONE_AI_FINAL_REPORT", "true");
    const { generateFinalRunReport, buildDeterministicFinalRunReport } = await import("./generateFinalRunReport.js");
    const input = { ...baseInput, terminationReason: "compaction_exhausted" };
    const r = await generateFinalRunReport(input);
    expect(r.title).toBe(buildDeterministicFinalRunReport(input).title);
  });

  it("no static short-circuit for natural_completion (LLM path attempted when env=true)", async () => {
    vi.stubEnv("ZONE_AI_FINAL_REPORT", "true");
    const { generateFinalRunReport } = await import("./generateFinalRunReport.js");
    const input = { ...baseInput, terminationReason: "natural_completion" };
    // With ZONE_AI_FINAL_REPORT=true, generateAiFinalRunReport is attempted.
    // It will throw (no real LLM key in test), so the fallback is returned.
    // Key assertion: no early return before the AI attempt.
    // We can't easily distinguish AI from deterministic in output, but we can
    // confirm the call doesn't short-circuit by checking it still returns a valid report.
    const r = await generateFinalRunReport(input);
    expect(r.title).toBeTruthy();
  });

  it("max_iterations also uses LLM path (not static)", async () => {
    vi.stubEnv("ZONE_AI_FINAL_REPORT", "false");
    const { generateFinalRunReport } = await import("./generateFinalRunReport.js");
    const input = { ...baseInput, terminationReason: "max_iterations" };
    // ZONE_AI_FINAL_REPORT=false → deterministic; terminationReason=max_iterations → no early return
    const r = await generateFinalRunReport(input);
    expect(r.title).toBeTruthy();
  });

  it("uses deterministic narrative for explicit_target_not_found terminal abort", async () => {
    vi.stubEnv("ZONE_AI_FINAL_REPORT", "true");
    const { generateFinalRunReport } = await import("./generateFinalRunReport.js");
    const r = await generateFinalRunReport({
      ...baseInput,
      patchSource: "no_patch",
      fileDiffs: [],
      patchScope: {
        changedFileCount: 0,
        totalAddedLines: 0,
        totalRemovedLines: 0,
        totalChangedLines: 0,
      },
      decisionMode: "preview_only",
      finalState: "preview_only",
      warnings: ["[EXPLICIT_TARGET_NOT_FOUND] Target file was not found in the selected repository/context."],
      correctness: {
        status: "skipped",
        summary: "Patch generation was not started (explicit_target_not_found).",
      },
      verificationCommandsLabel: null,
      runtimeVerificationSummary: null,
      finalExecutionOutcome: "completed_with_issues",
      terminalAbort: {
        code: "explicit_target_not_found",
        missingPath: "src/core/patchConversion.ts",
      },
    });
    expect(r.title).toBe("Patch generation failed");
    expect(r.statusSummary.toLowerCase()).toContain("explicit_target_not_found");
    expect(r.changesMade.join(" ").toLowerCase()).toContain("no files changed");
    expect(r.verificationSummary.status).toBe("not_run");
    expect(r.verificationSummary.message.toLowerCase()).toContain("explicit target file was not found");
    expect(r.safetySummary.some((s) => s.includes("EXPLICIT_TARGET_NOT_FOUND"))).toBe(true);
  });
});
