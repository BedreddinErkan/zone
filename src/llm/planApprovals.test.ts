/**
 * planApprovals state machine tests.
 * Mirrors revisionApprovals.test.ts in structure.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  requestPlanApproval,
  resolvePlanApproval,
  rejectPendingPlansForRun,
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
});

describe("autoApprove bypass", () => {
  it("resolves immediately with 'accept_all' and no SSE emission when autoApprove=true", async () => {
    const { emit, events } = makeEmit();
    const result = await requestPlanApproval({ proposal: PROPOSAL, emit: emit as any, autoApprove: true });
    expect(result.decision).toBe("accept_all");
    expect(result.planId).toBe(PROPOSAL.planId);
    expect(events).toHaveLength(0);
  });

  it("autoApprove=false falls through to normal SSE path", async () => {
    const { emit, events } = makeEmit();
    const p = requestPlanApproval({ proposal: PROPOSAL, emit: emit as any, autoApprove: false });
    await Promise.resolve();
    expect(events).toHaveLength(1);
    resolvePlanApproval({ planId: PROPOSAL.planId, runId: PROPOSAL.runId, decision: "accept_all" });
    const result = await p;
    expect(result.decision).toBe("accept_all");
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
  });

  it("resolves immediately with 'reject' when signal already aborted", async () => {
    const { emit, events } = makeEmit();
    const ac = new AbortController();
    ac.abort();
    const result = await requestPlanApproval({ proposal: PROPOSAL, emit: emit as any, abortSignal: ac.signal });
    expect(result.decision).toBe("reject");
    expect(events).toHaveLength(0);
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
