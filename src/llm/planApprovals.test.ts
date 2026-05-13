import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  requestPlanApproval,
  resolvePlanApproval,
  rejectPendingPlansForRun,
  validateExecutionPlan,
  validateRegenerateFeedback,
  shouldRequirePlanApproval,
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

describe("validateRegenerateFeedback", () => {
  it("rejects non-string input", () => {
    const r = validateRegenerateFeedback(42);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/string/);
  });

  it("rejects empty / whitespace-only string", () => {
    expect(validateRegenerateFeedback("").ok).toBe(false);
    expect(validateRegenerateFeedback("   ").ok).toBe(false);
  });

  it("rejects strings longer than 500 characters", () => {
    const r = validateRegenerateFeedback("x".repeat(501));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/500/);
  });

  it("accepts a valid feedback string", () => {
    expect(validateRegenerateFeedback("Please add a rollback step.").ok).toBe(true);
    expect(validateRegenerateFeedback("x".repeat(500)).ok).toBe(true);
  });
});

describe("resolvePlanApproval — regenerate action", () => {
  it("resolves with userFeedback when action is regenerate", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "regen1", plan: PLAN, emit: emit as any, timeoutMs: 5000 });
    const approvalId = String((events[0] as Record<string, unknown>)["approvalId"]);
    const r = resolvePlanApproval({ approvalId, action: "regenerate", runId: "regen1", userFeedback: "Add rollback step" });
    expect(r.ok).toBe(true);
    const { result } = await promise;
    expect(result.action).toBe("regenerate");
    if (result.action === "regenerate") expect(result.userFeedback).toBe("Add rollback step");
  });

  it("trims userFeedback before resolving", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "regen2", plan: PLAN, emit: emit as any, timeoutMs: 5000 });
    const approvalId = String((events[0] as Record<string, unknown>)["approvalId"]);
    resolvePlanApproval({ approvalId, action: "regenerate", runId: "regen2", userFeedback: "  trim me  " });
    const { result } = await promise;
    if (result.action === "regenerate") expect(result.userFeedback).toBe("trim me");
  });

  it("returns error when userFeedback is missing for regenerate", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "regen3", plan: PLAN, emit: emit as any, timeoutMs: 5000 });
    const approvalId = String((events[0] as Record<string, unknown>)["approvalId"]);
    const r = resolvePlanApproval({ approvalId, action: "regenerate", runId: "regen3" });
    expect(r.ok).toBe(false);
    // Cleanup
    resolvePlanApproval({ approvalId, action: "reject", runId: "regen3" });
    await promise;
  });

  it("returns error when userFeedback exceeds 500 chars", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "regen4", plan: PLAN, emit: emit as any, timeoutMs: 5000 });
    const approvalId = String((events[0] as Record<string, unknown>)["approvalId"]);
    const r = resolvePlanApproval({ approvalId, action: "regenerate", runId: "regen4", userFeedback: "x".repeat(501) });
    expect(r.ok).toBe(false);
    // Cleanup
    resolvePlanApproval({ approvalId, action: "reject", runId: "regen4" });
    await promise;
  });
});

describe("requestPlanApproval — regenAttempt / maxRegens emitted", () => {
  it("emits regenAttempt and maxRegens on the plan_ready_for_review event", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({
      runId: "ra1", plan: PLAN, emit: emit as any, timeoutMs: 5000,
      regenAttempt: 2, maxRegens: 3,
    });
    const evt = events[0] as Record<string, unknown>;
    expect(evt["regenAttempt"]).toBe(2);
    expect(evt["maxRegens"]).toBe(3);
    resolvePlanApproval({ approvalId: String(evt["approvalId"]), action: "reject", runId: "ra1" });
    await promise;
  });

  it("defaults regenAttempt to 0 and maxRegens to 3 when omitted", async () => {
    const { emit, events } = makeEmit();
    const promise = requestPlanApproval({ runId: "ra2", plan: PLAN, emit: emit as any, timeoutMs: 5000 });
    const evt = events[0] as Record<string, unknown>;
    expect(evt["regenAttempt"]).toBe(0);
    expect(evt["maxRegens"]).toBe(3);
    resolvePlanApproval({ approvalId: String(evt["approvalId"]), action: "reject", runId: "ra2" });
    await promise;
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

describe("shouldRequirePlanApproval", () => {
  // Opt-in default: plan review is OFF unless enablePlanReview is explicitly true
  it("defaults to false for patch mode when enablePlanReview is unset", () => {
    const { planApprovalRequired, normalizedMode } = shouldRequirePlanApproval({ rawMode: "patch" });
    expect(planApprovalRequired).toBe(false);
    expect(normalizedMode).toBe("patch");
  });

  it("returns false for patch mode when enablePlanReview is false", () => {
    const { planApprovalRequired } = shouldRequirePlanApproval({ rawMode: "patch", enablePlanReview: false });
    expect(planApprovalRequired).toBe(false);
  });

  it("returns true for patch mode when enablePlanReview is true", () => {
    const { planApprovalRequired } = shouldRequirePlanApproval({ rawMode: "patch", enablePlanReview: true });
    expect(planApprovalRequired).toBe(true);
  });

  it("does not require approval for chat mode even when enablePlanReview is true", () => {
    const { planApprovalRequired } = shouldRequirePlanApproval({ rawMode: "chat", enablePlanReview: true });
    expect(planApprovalRequired).toBe(false);
  });

  it("does not require approval for auto mode", () => {
    const { planApprovalRequired } = shouldRequirePlanApproval({ rawMode: "auto", enablePlanReview: true });
    expect(planApprovalRequired).toBe(false);
  });

  it("does not require approval for investigate mode", () => {
    const { planApprovalRequired } = shouldRequirePlanApproval({ rawMode: "investigate", enablePlanReview: true });
    expect(planApprovalRequired).toBe(false);
  });

  // Legacy "plan" mode alias — always forces approval
  it("normalizes 'plan' to 'patch' and forces planApprovalRequired true", () => {
    const { planApprovalRequired, normalizedMode } = shouldRequirePlanApproval({ rawMode: "plan" });
    expect(planApprovalRequired).toBe(true);
    expect(normalizedMode).toBe("patch");
  });

  it("forces planApprovalRequired true for 'plan' even when enablePlanReview is false", () => {
    const { planApprovalRequired, normalizedMode } = shouldRequirePlanApproval({
      rawMode: "plan",
      enablePlanReview: false,
    });
    expect(planApprovalRequired).toBe(true);
    expect(normalizedMode).toBe("patch");
  });

  // Explicit override
  it("explicit planApprovalRequired:false wins over patch+enablePlanReview:true", () => {
    const { planApprovalRequired } = shouldRequirePlanApproval({
      rawMode: "patch",
      enablePlanReview: true,
      explicitPlanApprovalRequired: false,
    });
    expect(planApprovalRequired).toBe(false);
  });

  it("explicit planApprovalRequired:true activates approval even for chat mode", () => {
    const { planApprovalRequired } = shouldRequirePlanApproval({
      rawMode: "chat",
      explicitPlanApprovalRequired: true,
    });
    expect(planApprovalRequired).toBe(true);
  });

  // Legacy skipPlanReview field derivation (done by server.ts caller, tested here via enablePlanReview)
  it("skipPlanReview:true → enablePlanReview:false → no approval for patch", () => {
    // server.ts derives enablePlanReview = !skipPlanReview before calling this function
    const { planApprovalRequired } = shouldRequirePlanApproval({ rawMode: "patch", enablePlanReview: false });
    expect(planApprovalRequired).toBe(false);
  });

  it("skipPlanReview:false → enablePlanReview:true → requires approval for patch", () => {
    const { planApprovalRequired } = shouldRequirePlanApproval({ rawMode: "patch", enablePlanReview: true });
    expect(planApprovalRequired).toBe(true);
  });
});
