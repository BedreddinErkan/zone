import { describe, it, expect } from "vitest";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import type { StoreAction } from "../store.js";
import {
  handlePlanGenerationStarted,
  handlePlanReadyForApprovalExported,
} from "./useAgentEvents.js";

function capture(): { calls: StoreAction[]; dispatch: (a: StoreAction) => void } {
  const calls: StoreAction[] = [];
  return { calls, dispatch: (a) => { calls.push(a); } };
}

describe("handlePlanGenerationStarted", () => {
  it("dispatches SPINNER_START with the event title", () => {
    const { calls, dispatch } = capture();
    handlePlanGenerationStarted(
      { type: "plan_generation_started", title: "Planning…", ts: 0 } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ type: "SPINNER_START", label: "Planning…" });
  });

  it("defaults label to 'Planning…' when title is absent", () => {
    const { calls, dispatch } = capture();
    handlePlanGenerationStarted(
      { type: "plan_generation_started", ts: 0 } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls[0]).toEqual({ type: "SPINNER_START", label: "Planning…" });
  });

  it("uses Replanning… title from re-plan events", () => {
    const { calls, dispatch } = capture();
    handlePlanGenerationStarted(
      { type: "plan_generation_started", title: "Replanning…", ts: 0 } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls[0]).toEqual({ type: "SPINNER_START", label: "Replanning…" });
  });
});

describe("handlePlanReadyForApprovalExported", () => {
  it("dispatches SPINNER_STOP then PLAN_READY_PROPOSED", () => {
    const { calls, dispatch } = capture();
    handlePlanReadyForApprovalExported(
      {
        type: "plan_ready_for_approval",
        title: "Plan ready",
        ts: 0,
        planId: "plan-1",
        runId: "run-1",
        planObjective: "Add feature X",
        planStepsJson: JSON.stringify([{ title: "Step 1", description: "Do it", filesLikely: ["src/a.ts"] }]),
      } as unknown as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ type: "SPINNER_STOP" });
    expect(calls[1]).toMatchObject({
      type: "PLAN_READY_PROPOSED",
      planId: "plan-1",
      runId: "run-1",
      objective: "Add feature X",
    });
    const proposed = calls[1] as Extract<StoreAction, { type: "PLAN_READY_PROPOSED" }>;
    expect(proposed.steps).toHaveLength(1);
    expect(proposed.steps[0].title).toBe("Step 1");
  });

  it("returns early without dispatching when planId is absent", () => {
    const { calls, dispatch } = capture();
    handlePlanReadyForApprovalExported(
      { type: "plan_ready_for_approval", title: "", ts: 0 } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls).toHaveLength(0);
  });

  it("uses empty steps array when planStepsJson is absent", () => {
    const { calls, dispatch } = capture();
    handlePlanReadyForApprovalExported(
      { type: "plan_ready_for_approval", title: "", ts: 0, planId: "p2", runId: "r2" } as unknown as ZoneStructuredProgressEvent,
      dispatch
    );
    const proposed = calls[1] as Extract<StoreAction, { type: "PLAN_READY_PROPOSED" }>;
    expect(proposed.steps).toEqual([]);
  });

  it("uses empty steps array when planStepsJson is malformed JSON", () => {
    const { calls, dispatch } = capture();
    handlePlanReadyForApprovalExported(
      { type: "plan_ready_for_approval", title: "", ts: 0, planId: "p3", runId: "r3", planStepsJson: "not-json" } as unknown as ZoneStructuredProgressEvent,
      dispatch
    );
    const proposed = calls[1] as Extract<StoreAction, { type: "PLAN_READY_PROPOSED" }>;
    expect(proposed.steps).toEqual([]);
  });
});
