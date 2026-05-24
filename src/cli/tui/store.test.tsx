import { describe, it, expect } from "vitest";
import { reducer, buildInitialState } from "./store.js";

function initialState() {
  return buildInitialState({ model: "test-model", capUsd: 10 });
}

const PLAN_ACTION = {
  type: "PLAN_PROPOSED" as const,
  revisionId: "rev-1",
  runId: "run-1",
  revisionType: "over_scope" as const,
  revisionReason: "Too many files",
  originalPlan: "Original plan text",
  revisedPlanSummary: "Revised plan text",
};

describe("MODE_CYCLE", () => {
  it("rotates normal → autoAccept → plan → normal", () => {
    let s = initialState();
    expect(s.mode).toBe("normal");

    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.mode).toBe("autoAccept");

    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.mode).toBe("plan");

    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.mode).toBe("normal");
  });

  it("no-op when modalView !== 'none'", () => {
    const s = { ...initialState(), modalView: "permissions" as const };
    const next = reducer(s, { type: "MODE_CYCLE" });
    expect(next.mode).toBe("normal");
    expect(next).toBe(s); // same reference — no state change
  });

  it("no-op when pendingApproval !== null", () => {
    const s = {
      ...initialState(),
      pendingApproval: { approvalId: "a1", runId: "r1", command: "npm test" },
    };
    const next = reducer(s, { type: "MODE_CYCLE" });
    expect(next.mode).toBe("normal");
    expect(next).toBe(s);
  });

  it("PENDING_APPROVAL_RESOLVED clears pendingApproval regardless of mode", () => {
    let s = { ...initialState(), pendingApproval: { approvalId: "a1", runId: "r1", command: "npm test" } };
    s = reducer(s, { type: "MODE_CYCLE" }); // no-op because pendingApproval set
    expect(s.pendingApproval).not.toBeNull();
    s = reducer(s, { type: "PENDING_APPROVAL_RESOLVED" });
    expect(s.pendingApproval).toBeNull();
    // Now MODE_CYCLE should work
    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.mode).toBe("autoAccept");
  });
});

describe("PLAN_PROPOSED / PLAN_RESOLVED", () => {
  it("PLAN_PROPOSED sets planProposal + modalView:'plan'", () => {
    const s = reducer(initialState(), PLAN_ACTION);
    expect(s.modalView).toBe("plan");
    expect(s.planProposal).not.toBeNull();
    expect(s.planProposal?.revisionId).toBe("rev-1");
    expect(s.planProposal?.revisionType).toBe("over_scope");
  });

  it("PLAN_RESOLVED clears planProposal + modalView:'none'", () => {
    let s = reducer(initialState(), PLAN_ACTION);
    s = reducer(s, { type: "PLAN_RESOLVED" });
    expect(s.modalView).toBe("none");
    expect(s.planProposal).toBeNull();
  });

  it("PLAN_PROPOSED does not change mode", () => {
    const base = { ...initialState(), mode: "autoAccept" as const };
    const s = reducer(base, PLAN_ACTION);
    expect(s.mode).toBe("autoAccept");
  });

  it("MODE_CYCLE does not affect planProposal", () => {
    let s = reducer(initialState(), PLAN_ACTION);
    // planProposal is set; MODE_CYCLE is guarded by modalView:'plan' ≠ 'none'
    s = reducer(s, { type: "MODE_CYCLE" });
    expect(s.planProposal).not.toBeNull();
    expect(s.mode).toBe("normal"); // unchanged
  });
});
