import { describe, it, expect } from "vitest";
import { reducer, buildInitialState, selectEscTarget, type StoreAction } from "./store-core.js";

const base = () => buildInitialState({ model: "test-model", capUsd: 10 });

describe("selectEscTarget", () => {
  it("returns 'none' when everything is idle", () => {
    expect(selectEscTarget(base())).toBe("none");
  });

  it("returns 'submode' when overlaySubModeOpen is true (even with overlay open)", () => {
    let s = reducer(base(), { type: "OVERLAY_PUSH", overlayId: "model" });
    s = reducer(s, { type: "OVERLAY_SUBMODE_OPEN" });
    expect(selectEscTarget(s)).toBe("submode");
  });

  it("returns 'overlay' when overlayStack has entries and no submode", () => {
    const s = reducer(base(), { type: "OVERLAY_PUSH", overlayId: "model" });
    expect(selectEscTarget(s)).toBe("overlay");
  });

  it("returns 'question' when pendingQuestion is set and no overlay", () => {
    const s = reducer(base(), {
      type: "PENDING_APPROVAL_SET",
      approvalId: "a1", runId: "r1", command: "echo", kind: "command",
    });
    // pendingApproval is not a question; let's use a carried question
    const s2 = { ...base(), pendingQuestion: { kind: "carried" as const, questionId: "q1", runId: "r1", iter: 1, text: "q" } as never };
    expect(selectEscTarget(s2)).toBe("question");
  });

  it("returns 'run' when runState is running and no overlay/question", () => {
    const s = { ...base(), runState: "running" as const };
    expect(selectEscTarget(s)).toBe("run");
  });

  it("'submode' takes precedence over 'overlay'", () => {
    let s = reducer(base(), { type: "OVERLAY_PUSH", overlayId: "keys" });
    s = reducer(s, { type: "OVERLAY_SUBMODE_OPEN" });
    expect(selectEscTarget(s)).toBe("submode");
  });

  it("'overlay' takes precedence over 'run'", () => {
    let s = reducer(base(), { type: "OVERLAY_PUSH", overlayId: "effort" });
    s = { ...s, runState: "running" as const };
    expect(selectEscTarget(s)).toBe("overlay");
  });
});

describe("OVERLAY_SUBMODE_OPEN / CLOSE reducer", () => {
  it("OPEN sets overlaySubModeOpen to true", () => {
    const s = reducer(base(), { type: "OVERLAY_SUBMODE_OPEN" });
    expect(s.overlaySubModeOpen).toBe(true);
  });

  it("CLOSE sets overlaySubModeOpen to false", () => {
    let s = reducer(base(), { type: "OVERLAY_SUBMODE_OPEN" });
    s = reducer(s, { type: "OVERLAY_SUBMODE_CLOSE" });
    expect(s.overlaySubModeOpen).toBe(false);
  });

  it("OVERLAY_PUSH resets submode to false", () => {
    let s = reducer(base(), { type: "OVERLAY_SUBMODE_OPEN" });
    expect(s.overlaySubModeOpen).toBe(true);
    s = reducer(s, { type: "OVERLAY_PUSH", overlayId: "model" });
    expect(s.overlaySubModeOpen).toBe(false);
  });

  it("OVERLAY_POP resets submode to false", () => {
    let s = reducer(base(), { type: "OVERLAY_PUSH", overlayId: "model" });
    s = reducer(s, { type: "OVERLAY_SUBMODE_OPEN" });
    s = reducer(s, { type: "OVERLAY_POP" });
    expect(s.overlaySubModeOpen).toBe(false);
  });

  it("OVERLAY_CLEAR resets submode to false", () => {
    let s = reducer(base(), { type: "OVERLAY_PUSH", overlayId: "model" });
    s = reducer(s, { type: "OVERLAY_SUBMODE_OPEN" });
    s = reducer(s, { type: "OVERLAY_CLEAR" });
    expect(s.overlaySubModeOpen).toBe(false);
  });
});

describe("Esc precedence — double-pop regression", () => {
  it("two Esc presses pop exactly two entries, never three", () => {
    let s = base();
    s = reducer(s, { type: "OVERLAY_PUSH", overlayId: "model" });
    s = reducer(s, { type: "OVERLAY_PUSH", overlayId: "keys" });
    expect(s.overlayStack).toEqual(["model", "keys"]);

    // First Esc — pop keys
    s = reducer(s, { type: "OVERLAY_POP" });
    expect(s.overlayStack).toEqual(["model"]);

    // Second Esc — pop model
    s = reducer(s, { type: "OVERLAY_POP" });
    expect(s.overlayStack).toEqual([]);

    // Third Esc — no-op (empty stack)
    const before = s;
    s = reducer(s, { type: "OVERLAY_POP" });
    expect(s).toBe(before); // same reference = no-op
  });
});
