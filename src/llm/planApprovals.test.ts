import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  requestPlanApproval,
  resolvePlanApproval,
  rejectPendingPlansForRun,
  validateExecutionPlan,
  type PlanApprovalAction,
} from "./planApprovals.js";
import type { ExecutionPlan } from "./executionPlan.js";

const PLAN: ExecutionPlan = {
  objective: "Add a login button",
  steps: [
    { title: "Create component", description: "Add LoginButton.tsx", filesLikely: ["src/LoginButton.tsx"] },
    { title: "Wire up", description: "Import in App.tsx", filesLikely: ["src/App.tsx"] },
  ],
  riskHints: ["May affect auth flow"],
  scopeSummary: "Login button + App wiring",
};

function makeEmit() {
  const events: unknown[] = [];
  return {
    emit: (evt: unknown) => { events.push(evt); },
    events,
  };
}

describe("validateExecutionPlan", () => {
  it("accepts a valid plan", () => {
    const result = validateExecutionPlan(PLAN);
    expect(result).not.toBeNull();
    expect(result?.objective).toBe(PLAN.objective);
    expect(result?.steps).toHaveLength(2);
  });

  it("returns null for null/undefined", () => {
    expect(validateExecutionPlan(null)).toBeNull();
    expect(validateExecutionPlan(undefined)).toBeNull();
  });

  it("returns null when objective is missing", () => {
    expect(validateExecutionPlan({ ...PLAN, objective: 42 })).toBeNull();
  });

  it("returns null when steps is empty array", () => {
    expect(validateExecutionPlan({ ...PLAN, steps: [] })).toBeNull();
  });

  it("returns null when a step is malformed", () => {
    expect(validateExecutionPlan({ ...PLAN, steps: [{ title: 123 }] })).toBeNull();
  });

  it("returns null when riskHints is missing", () => {
    const { riskHints: _, ...rest } = PLAN;
    expect(validateExecutionPlan(rest)).toBeNull();
  });

  it("filters non-string entries from filesLikely and riskHints", () => {
    const raw = {
      ...PLAN,
      steps: [{ title: "s", description: "d", filesLikely: ["a.ts", 42, null] }],
      riskHints: ["risk", 99],
    };
    const result = validateExecutionPlan(raw);
    expect(result?.steps[0]?.filesLikely).toEqual(["a.ts"]);
    expect(result?.riskHints).toEqual(["risk"]);
  });
});

describe("requestPlanApproval / resolvePlanApproval", () => {
  it("emits plan_ready_for_review event with approvalId", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "run1", plan: PLAN, emit: emit as any, timeoutMs: 5000 });

    expect(events).toHaveLength(1);
    const evt = events[0] as Record<string, unknown>;
    expect(evt["type"]).toBe("plan_ready_for_review");
    expect(typeof evt["approvalId"]).toBe("string");
    expect(evt["runId"]).toBe("run1");

    const approvalId = String(evt["approvalId"]);
    resolvePlanApproval({ approvalId, action: "approve", runId: "run1" });
    const { result } = await promise;
    expect(result.action).toBe("approve");
    if (result.action === "approve") expect(result.plan).toEqual(PLAN);
  });

  it("resolves with reject when action is reject", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "run2", plan: PLAN, emit: emit as any, timeoutMs: 5000 });
    const approvalId = String((events[0] as Record<string, unknown>)["approvalId"]);
    resolvePlanApproval({ approvalId, action: "reject", runId: "run2" });
    const { result } = await promise;
    expect(result.action).toBe("reject");
  });

  it("resolves with edited plan when action is edit", async () => {
    const edited: ExecutionPlan = { ...PLAN, objective: "Edited objective" };
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "run3", plan: PLAN, emit: emit as any, timeoutMs: 5000 });
    const approvalId = String((events[0] as Record<string, unknown>)["approvalId"]);
    resolvePlanApproval({ approvalId, action: "edit", runId: "run3", editedPlan: edited });
    const { result } = await promise;
    expect(result.action).toBe("edit");
    if (result.action === "edit") expect(result.plan.objective).toBe("Edited objective");
  });

  it("returns run_id_mismatch when runId doesn't match", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "run4", plan: PLAN, emit: emit as any, timeoutMs: 5000 });
    const approvalId = String((events[0] as Record<string, unknown>)["approvalId"]);
    const r = resolvePlanApproval({ approvalId, action: "approve", runId: "wrong-run" });
    expect(r.ok).toBe(false);
    expect(r.message).toBe("run_id_mismatch");
    // Cleanup: resolve with correct runId so the promise doesn't hang
    resolvePlanApproval({ approvalId, action: "reject", runId: "run4" });
    await promise;
  });

  it("returns unknown_approval_id for unknown approvalId", () => {
    const r = resolvePlanApproval({ approvalId: "no-such-id", action: "approve", runId: "any" });
    expect(r.ok).toBe(false);
    expect(r.message).toBe("unknown_approval_id");
  });

  it("returns invalid_edited_plan when editedPlan fails validation", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "run5", plan: PLAN, emit: emit as any, timeoutMs: 5000 });
    const approvalId = String((events[0] as Record<string, unknown>)["approvalId"]);
    const r = resolvePlanApproval({ approvalId, action: "edit", runId: "run5", editedPlan: { bad: "data" } });
    expect(r.ok).toBe(false);
    expect(r.message).toBe("invalid_edited_plan");
    // Cleanup
    resolvePlanApproval({ approvalId, action: "reject", runId: "run5" });
    await promise;
  });

  it("times out and resolves with reject after timeoutMs", async () => {
    vi.useFakeTimers();
    const { emit } = makeEmit();
    const promise = requestPlanApproval({ runId: "run6", plan: PLAN, emit: emit as any, timeoutMs: 100 });
    vi.advanceTimersByTime(150);
    const { result } = await promise;
    expect(result.action).toBe("reject");
    vi.useRealTimers();
  });
});

describe("rejectPendingPlansForRun", () => {
  it("rejects all pending plans for a runId and returns count", async () => {
    const { emit: emit1, events: events1 } = makeEmit();
    const { emit: emit2, events: events2 } = makeEmit();
    const p1 = requestPlanApproval({ runId: "batchRun", plan: PLAN, emit: emit1 as any, timeoutMs: 30000 });
    const p2 = requestPlanApproval({ runId: "batchRun", plan: PLAN, emit: emit2 as any, timeoutMs: 30000 });
    const n = rejectPendingPlansForRun("batchRun");
    expect(n).toBe(2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.result.action).toBe("reject");
    expect(r2.result.action).toBe("reject");
  });

  it("returns 0 when no plans pending for runId", () => {
    expect(rejectPendingPlansForRun("no-such-run")).toBe(0);
  });

  it("returns 0 for empty runId", () => {
    expect(rejectPendingPlansForRun("")).toBe(0);
  });
});
