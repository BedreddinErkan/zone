/**
 * planApprovals state machine tests.
 * Mirrors revisionApprovals.test.ts in structure.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  requestPlanApproval,
  resolvePlanApproval,
  rejectPendingPlansForRun,
  emitPlanEmptyApproval,
  type PlanReadyProposal,
} from "./planApprovals.js";

const PROPOSAL: PlanReadyProposal = {
  runId: "run-plan-001",
  planId: "plan-uuid-001",
  objective: "Add feature X to the codebase.",
  steps: [
    { title: "Read relevant files", description: "Understand the codebase", filesLikely: ["src/foo.ts"] },
    { title: "Implement feature", description: "Write the code", filesLikely: ["src/bar.ts"] },
  ],
  riskHints: ["Touches shared auth middleware"],
  scopeSummary: "Add feature X behind a flag in the request-handling path.",
};

function makeEmit() {
  const events: unknown[] = [];
  return {
    emit: (evt: unknown) => { events.push(evt); },
    events,
  };
}

describe("requestPlanApproval + resolvePlanApproval", () => {
  it("emits plan_ready_for_approval event with planId and planObjective", async () => {
    const { emit, events } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    expect(events).toHaveLength(1);
    const evt = events[0] as Record<string, unknown>;
    expect(evt["type"]).toBe("plan_ready_for_approval");
    expect(evt["planId"]).toBe(PROPOSAL.planId);
    expect(evt["runId"]).toBe("run-plan-001");
    expect(evt["planObjective"]).toBe(PROPOSAL.objective);
    expect(typeof evt["planStepsJson"]).toBe("string");

    resolvePlanApproval({ planId: PROPOSAL.planId, runId: "run-plan-001", decision: "reject" });
    await p;
  });

  it("planStepsJson is valid JSON encoding steps", async () => {
    const { emit, events } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    const evt = events[0] as Record<string, unknown>;
    const parsed = JSON.parse(evt["planStepsJson"] as string);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe("Read relevant files");

    resolvePlanApproval({ planId: PROPOSAL.planId, runId: "run-plan-001", decision: "reject" });
    await p;
  });

  it("resolves with 'accept_all' when accept_all decision is submitted", async () => {
    const { emit, events } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    expect(events).toHaveLength(1);
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: "run-plan-001", decision: "accept_all" });
    const result = await p;
    expect(result.decision).toBe("accept_all");
    expect(result.planId).toBe(PROPOSAL.planId);
  });

  it("resolves with 'manual' decision", async () => {
    const { emit } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: "run-plan-001", decision: "manual" });
    const result = await p;
    expect(result.decision).toBe("manual");
  });

  it("resolves with 'reject' when reject decision is submitted", async () => {
    const { emit } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: "run-plan-001", decision: "reject" });
    const result = await p;
    expect(result.decision).toBe("reject");
  });

  it("resolves with 'feedback' decision and carries feedback text", async () => {
    const { emit } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: "run-plan-001", decision: "feedback", feedback: "please add unit tests" });
    const result = await p;
    expect(result.decision).toBe("feedback");
    expect(result.feedback).toBe("please add unit tests");
  });

  it("resolves with 'approve_with_feedback' decision and carries feedback text", async () => {
    const { emit } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: "run-plan-001", decision: "approve_with_feedback", feedback: "be concise" });
    const result = await p;
    expect(result.decision).toBe("approve_with_feedback");
    expect(result.feedback).toBe("be concise");
  });

  it("feedback is undefined when not provided for non-feedback decisions", async () => {
    const { emit } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: "run-plan-001", decision: "accept_all" });
    const result = await p;
    expect(result.feedback).toBeUndefined();
  });

  it("returns ok:false for unknown planId", () => {
    const r = resolvePlanApproval({ planId: "nonexistent", runId: "run-x", decision: "accept_all" });
    expect(r.ok).toBe(false);
    expect(r.message).toBe("unknown_plan_id");
  });

  it("returns ok:false for run_id_mismatch", async () => {
    const { emit } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    const r = resolvePlanApproval({ planId: PROPOSAL.planId, runId: "wrong-run", decision: "accept_all" });
    expect(r.ok).toBe(false);
    expect(r.message).toBe("run_id_mismatch");
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: "run-plan-001", decision: "reject" });
    await p;
  });

  // Proven live this pass: threw synchronously inside `new Promise(...)` — "Cannot read
  // properties of undefined (reading 'slice')" — before the `?? ""` guard existed. autoApprove
  // short-circuits before ever reaching this line, so only the real (non-autoApprove) emit path
  // exercises it — the exact path this test uses.
  it("does not throw when proposal.objective is absent (narrative-only plan, non-autoApprove path)", async () => {
    const { emit, events } = makeEmit();
    const narrativeOnly: PlanReadyProposal = {
      runId: "run-narrative-001",
      planId: "plan-narrative-001",
      steps: [],
      narrative: "## Narrative-only plan\n\nNo objective field at all.",
    };
    expect(() => requestPlanApproval({ proposal: narrativeOnly, emit: emit as any })).not.toThrow();
    await Promise.resolve();
    expect(events).toHaveLength(1);
    const evt = events[0] as Record<string, unknown>;
    expect(evt["title"]).toBe("Plan ready: ");
    resolvePlanApproval({ planId: narrativeOnly.planId, runId: "run-narrative-001", decision: "reject" });
  });
});

describe("autoApprove bypass", () => {
  it("resolves immediately with 'accept_all' and no SSE emission when autoApprove=true", async () => {
    const { emit, events } = makeEmit();
    const result = await requestPlanApproval({ proposal: PROPOSAL, emit: emit as any, autoApprove: true });
    expect(result.decision).toBe("accept_all");
    expect(result.planId).toBe(PROPOSAL.planId);
    expect(events).toHaveLength(0);
    // The modal was never shown — reviewed-style callers must be able to tell this apart
    // from a real user decision, from this return value alone.
    expect(result.modalEmitted).toBe(false);
  });

  it("autoApprove=false falls through to normal SSE path", async () => {
    const { emit, events } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any, autoApprove: false });
    await Promise.resolve();
    expect(events).toHaveLength(1);
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: PROPOSAL.runId, decision: "accept_all" });
    const result = await p;
    expect(result.decision).toBe("accept_all");
    expect(result.modalEmitted).toBe(true);
  });
});

describe("abort signal", () => {
  it("resolves with 'reject' when abort signal fires", async () => {
    const { emit } = makeEmit();
    const ac = new AbortController();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any, abortSignal: ac.signal });
    await Promise.resolve();
    ac.abort();
    const result = await p;
    expect(result.decision).toBe("reject");
    // The modal WAS shown before the later abort fired.
    expect(result.modalEmitted).toBe(true);
  });

  it("resolves immediately with 'reject' when signal already aborted", async () => {
    const { emit, events } = makeEmit();
    const ac = new AbortController();
    ac.abort();
    const result = await requestPlanApproval({ proposal: PROPOSAL, emit: emit as any, abortSignal: ac.signal });
    expect(result.decision).toBe("reject");
    expect(events).toHaveLength(0);
    // Second divergence named in Establish #3: skips input.emit independent of autoApprove.
    expect(result.modalEmitted).toBe(false);
  });
});

describe("rejectPendingPlansForRun", () => {
  it("rejects pending plans matching runId and returns count", async () => {
    const { emit } = makeEmit();
    const proposal2 = { ...PROPOSAL, runId: "run-rej-002", planId: "plan-rej-002" };
    const p = requestPlanApproval({ proposal: proposal2, emit: emit as any });
    await Promise.resolve();
    const n = rejectPendingPlansForRun("run-rej-002");
    expect(n).toBe(1);
    const result = await p;
    expect(result.decision).toBe("reject");
  });

  it("does not reject plans for a different runId", async () => {
    const { emit } = makeEmit();
    const proposal3 = { ...PROPOSAL, runId: "run-keep-003", planId: "plan-keep-003" };
    const p = requestPlanApproval({ proposal: proposal3, emit: emit as any });
    await Promise.resolve();
    const n = rejectPendingPlansForRun("run-other");
    expect(n).toBe(0);
    // Clean up
    resolvePlanApproval({ planId: "plan-keep-003", runId: "run-keep-003", decision: "reject" });
    await p;
  });

  it("returns 0 for empty runId", () => {
    expect(rejectPendingPlansForRun("")).toBe(0);
  });
});

// PlanReady projection: riskHints/scopeSummary threading (required fields, no presence check).
describe("riskHints / scopeSummary in PlanReadyProposal", () => {
  it("riskHints and scopeSummary on proposal are emitted as planRiskHints / planScopeSummary", async () => {
    const { emit, events } = makeEmit();
    const proposal: PlanReadyProposal = {
      ...PROPOSAL,
      planId: "plan-risk-001",
      riskHints: ["Touches shared auth middleware", "No test coverage on the affected path"],
      scopeSummary: "Add feature X behind a flag in the request-handling path.",
    };
    const p = requestPlanApproval({ proposal, emit: emit as any });
    await Promise.resolve();
    const evt = events[0] as Record<string, unknown>;
    expect(evt["planRiskHints"]).toEqual(["Touches shared auth middleware", "No test coverage on the affected path"]);
    expect(evt["planScopeSummary"]).toBe("Add feature X behind a flag in the request-handling path.");
    resolvePlanApproval({ planId: "plan-risk-001", runId: PROPOSAL.runId, decision: "reject" });
    await p;
  });
});

// Phase 2a: scopeNotes threading
describe("scopeNotes in PlanReadyProposal", () => {
  it("scopeNotes on proposal is emitted as planScopeNotes in the event", async () => {
    const { emit, events } = makeEmit();
    const proposal: PlanReadyProposal = {
      ...PROPOSAL,
      planId: "plan-scope-001",
      scopeNotes: "Auth module 80% done in src/auth.ts",
    };
    const p = requestPlanApproval({ proposal, emit: emit as any });
    await Promise.resolve();
    const evt = events[0] as Record<string, unknown>;
    expect(evt["planScopeNotes"]).toBe("Auth module 80% done in src/auth.ts");
    resolvePlanApproval({ planId: "plan-scope-001", runId: PROPOSAL.runId, decision: "reject" });
    await p;
  });

  it("planScopeNotes is absent in the event when scopeNotes is not set", async () => {
    const { emit, events } = makeEmit();
    const proposal: PlanReadyProposal = {
      ...PROPOSAL,
      planId: "plan-scope-002",
      // no scopeNotes
    };
    const p = requestPlanApproval({ proposal, emit: emit as any });
    await Promise.resolve();
    const evt = events[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(evt, "planScopeNotes")).toBe(false);
    resolvePlanApproval({ planId: "plan-scope-002", runId: PROPOSAL.runId, decision: "reject" });
    await p;
  });
});

// The gap: none of E8a/E8b/the forceSteps safety net (dispatch.ts) re-run after
// a replan, so a stepless plan carrying noChangeReason/cannotVerifyReason can
// reach this gate. Without these fields threaded through, the user sees an
// empty step list and four live action keys with no stated reason at all.
describe("noChangeReason / cannotVerifyReason in PlanReadyProposal", () => {
  it("noChangeReason on proposal is emitted as planNoChangeReason in the event", async () => {
    const { emit, events } = makeEmit();
    const proposal: PlanReadyProposal = {
      ...PROPOSAL,
      planId: "plan-nochange-001",
      steps: [],
      noChangeReason: "Build already exits 0 — the asserted bug does not reproduce.",
    };
    const p = requestPlanApproval({ proposal, emit: emit as any });
    await Promise.resolve();
    const evt = events[0] as Record<string, unknown>;
    expect(evt["planNoChangeReason"]).toBe("Build already exits 0 — the asserted bug does not reproduce.");
    expect(Object.prototype.hasOwnProperty.call(evt, "planCannotVerifyReason")).toBe(false);
    resolvePlanApproval({ planId: "plan-nochange-001", runId: PROPOSAL.runId, decision: "reject" });
    await p;
  });

  it("cannotVerifyReason on proposal is emitted as planCannotVerifyReason in the event", async () => {
    const { emit, events } = makeEmit();
    const proposal: PlanReadyProposal = {
      ...PROPOSAL,
      planId: "plan-cannotverify-001",
      steps: [],
      cannotVerifyReason: "Reproduce command was blocked — could not confirm the premise.",
    };
    const p = requestPlanApproval({ proposal, emit: emit as any });
    await Promise.resolve();
    const evt = events[0] as Record<string, unknown>;
    expect(evt["planCannotVerifyReason"]).toBe("Reproduce command was blocked — could not confirm the premise.");
    expect(Object.prototype.hasOwnProperty.call(evt, "planNoChangeReason")).toBe(false);
    resolvePlanApproval({ planId: "plan-cannotverify-001", runId: PROPOSAL.runId, decision: "reject" });
    await p;
  });

  it("both are absent in the event when neither is set on the proposal", async () => {
    const { emit, events } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    const evt = events[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(evt, "planNoChangeReason")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(evt, "planCannotVerifyReason")).toBe(false);
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: PROPOSAL.runId, decision: "reject" });
    await p;
  });
});

describe("emitPlanEmptyApproval", () => {
  it("logs unconditionally via console.log (log(), not debugLog — matches [zone-tier-grant-unusable])", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitPlanEmptyApproval({ runId: "run-x", reasonField: "noChangeReason", reviewed: true });
    expect(spy).toHaveBeenCalledWith(
      "[zone-plan-empty-approval]",
      JSON.stringify({ runId: "run-x", reasonField: "noChangeReason", reviewed: true }),
    );
    spy.mockRestore();
  });

  it("carries reviewed:false for the unreviewed (approve_with_feedback) arm", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitPlanEmptyApproval({ runId: "run-y", reasonField: "cannotVerifyReason", reviewed: false });
    expect(spy).toHaveBeenCalledWith(
      "[zone-plan-empty-approval]",
      JSON.stringify({ runId: "run-y", reasonField: "cannotVerifyReason", reviewed: false }),
    );
    spy.mockRestore();
  });
});
