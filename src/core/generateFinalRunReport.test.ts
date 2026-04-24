import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
});
