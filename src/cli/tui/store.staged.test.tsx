import { describe, it, expect } from "vitest";
import { reducer, buildInitialState } from "./store.js";
import type { StagedFile } from "../../core/fileDiff.js";

function initialState() {
  return buildInitialState({ model: "test-model", capUsd: 10 });
}

const STAGED_FILES: StagedFile[] = [
  { path: "src/foo.ts", findReplace: "--- FIND ---\nold\n--- REPLACE ---\nnew", added: 1, removed: 1 },
];

const PROPOSED_ACTION = {
  type: "STAGED_DIFFS_PROPOSED" as const,
  approvalId: "approval-001",
  runId: "run-001",
  files: STAGED_FILES,
  verificationSummary: "tsc ✓",
  trigger: "natural_completion",
};

describe("buildInitialState", () => {
  it("initializes stagedDiffProposal to null", () => {
    expect(initialState().stagedDiffProposal).toBeNull();
  });
});

describe("STAGED_DIFFS_PROPOSED", () => {
  it("sets modalView to staged_diffs and populates stagedDiffProposal", () => {
    const s0 = initialState();
    const s1 = reducer(s0, PROPOSED_ACTION);
    expect(s1.modalView).toBe("staged_diffs");
    expect(s1.stagedDiffProposal).not.toBeNull();
    expect(s1.stagedDiffProposal?.approvalId).toBe("approval-001");
    expect(s1.stagedDiffProposal?.runId).toBe("run-001");
    expect(s1.stagedDiffProposal?.files).toHaveLength(1);
    expect(s1.stagedDiffProposal?.verificationSummary).toBe("tsc ✓");
    expect(s1.stagedDiffProposal?.trigger).toBe("natural_completion");
  });

  it("preserves other state fields (transcript, mode, etc.)", () => {
    const s0 = { ...initialState(), mode: "plan" as const };
    const s1 = reducer(s0, PROPOSED_ACTION);
    expect(s1.mode).toBe("plan");
    expect(s1.transcript).toEqual(s0.transcript);
  });
});

describe("STAGED_DIFFS_RESOLVED", () => {
  it("clears stagedDiffProposal and resets modalView to none", () => {
    const s0 = reducer(initialState(), PROPOSED_ACTION);
    expect(s0.modalView).toBe("staged_diffs");

    const s1 = reducer(s0, { type: "STAGED_DIFFS_RESOLVED" });
    expect(s1.stagedDiffProposal).toBeNull();
    expect(s1.modalView).toBe("none");
  });

  it("preserves mode (not sticky-reset like PLAN_READY_RESOLVED)", () => {
    const s0 = { ...reducer(initialState(), PROPOSED_ACTION), mode: "plan" as const };
    const s1 = reducer(s0, { type: "STAGED_DIFFS_RESOLVED" });
    expect(s1.mode).toBe("plan");
  });
});
