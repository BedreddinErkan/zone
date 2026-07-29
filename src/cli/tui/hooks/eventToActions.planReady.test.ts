import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";

/**
 * None of E8a/E8b/the forceSteps safety net (dispatch.ts) re-run after a
 * replan, so a stepless plan carrying noChangeReason/cannotVerifyReason can
 * reach the modal. eventToActions is the last hop before render — it must
 * thread the reason through rather than let it silently disappear alongside
 * an empty step list.
 */

let debugLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const logger = await import("../../../utils/logger.js");
  debugLogSpy = vi.spyOn(logger, "debugLog").mockImplementation(() => {});
});

afterEach(() => {
  debugLogSpy.mockRestore();
});

function baseEvt(extra: Partial<ZoneStructuredProgressEvent> = {}): ZoneStructuredProgressEvent {
  return {
    type: "plan_ready_for_approval",
    runId: "run-1",
    ts: Date.now(),
    title: "Plan ready",
    planId: "plan-1",
    planObjective: "Fix the off-by-one",
    planStepsJson: "[]",
    ...extra,
  } as ZoneStructuredProgressEvent;
}

describe("eventToActions — plan_ready_for_approval reason threading", () => {
  it("threads noChangeReason from the event into PLAN_READY_PROPOSED", async () => {
    const { eventToActions } = await import("./eventToActions.js");
    const { actions } = eventToActions(
      baseEvt({ planNoChangeReason: "Build already exits 0." }),
      { trustedPrefixes: [], mode: "normal" },
    );
    const proposed = actions.find((a) => a.type === "PLAN_READY_PROPOSED") as
      | { noChangeReason?: string; cannotVerifyReason?: string }
      | undefined;
    expect(proposed).toBeDefined();
    expect(proposed!.noChangeReason).toBe("Build already exits 0.");
    expect(proposed!.cannotVerifyReason).toBeUndefined();
  });

  it("threads cannotVerifyReason from the event into PLAN_READY_PROPOSED", async () => {
    const { eventToActions } = await import("./eventToActions.js");
    const { actions } = eventToActions(
      baseEvt({ planCannotVerifyReason: "Reproduce command was blocked." }),
      { trustedPrefixes: [], mode: "normal" },
    );
    const proposed = actions.find((a) => a.type === "PLAN_READY_PROPOSED") as
      | { noChangeReason?: string; cannotVerifyReason?: string }
      | undefined;
    expect(proposed!.cannotVerifyReason).toBe("Reproduce command was blocked.");
    expect(proposed!.noChangeReason).toBeUndefined();
  });

  it("neither field is set when the event carries neither reason", async () => {
    const { eventToActions } = await import("./eventToActions.js");
    const { actions } = eventToActions(baseEvt(), { trustedPrefixes: [], mode: "normal" });
    const proposed = actions.find((a) => a.type === "PLAN_READY_PROPOSED") as
      | { noChangeReason?: string; cannotVerifyReason?: string }
      | undefined;
    expect(proposed!.noChangeReason).toBeUndefined();
    expect(proposed!.cannotVerifyReason).toBeUndefined();
  });

  it("does not emit TOAST_PUSH on either arm", async () => {
    const { eventToActions } = await import("./eventToActions.js");
    const { actions } = eventToActions(
      baseEvt({ planNoChangeReason: "Build already exits 0." }),
      { trustedPrefixes: [], mode: "normal" },
    );
    expect(actions.some((a) => a.type === "TOAST_PUSH")).toBe(false);
  });
});

describe("eventToActions — malformed planStepsJson (no known live producer)", () => {
  it("logs [zone-plan-steps-unparsed] via debugLog and renders with empty steps", async () => {
    const { eventToActions } = await import("./eventToActions.js");
    const { actions } = eventToActions(
      baseEvt({ planStepsJson: "{not valid json" }),
      { trustedPrefixes: [], mode: "normal" },
    );

    expect(debugLogSpy).toHaveBeenCalledWith(
      "[zone-plan-steps-unparsed]",
      JSON.stringify({ planId: "plan-1", runId: "run-1", payloadBytes: Buffer.byteLength("{not valid json", "utf8") }),
    );
    const proposed = actions.find((a) => a.type === "PLAN_READY_PROPOSED") as { steps: unknown[] } | undefined;
    expect(proposed!.steps).toEqual([]);
  });

  it("does not log anything when planStepsJson parses cleanly", async () => {
    const { eventToActions } = await import("./eventToActions.js");
    eventToActions(baseEvt({ planStepsJson: "[]" }), { trustedPrefixes: [], mode: "normal" });
    expect(debugLogSpy).not.toHaveBeenCalled();
  });

  it("does not emit TOAST_PUSH on the parse-failure arm", async () => {
    const { eventToActions } = await import("./eventToActions.js");
    const { actions } = eventToActions(
      baseEvt({ planStepsJson: "{not valid json" }),
      { trustedPrefixes: [], mode: "normal" },
    );
    expect(actions.some((a) => a.type === "TOAST_PUSH")).toBe(false);
  });
});
