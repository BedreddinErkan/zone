import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import React, { useRef } from "react";
import { StoreProvider, useStore } from "../store.js";
import { OverlayLayer } from "./OverlayLayer.js";
import {
  buildInitialState,
  reducer,
  selectIsBlockingModalOpen,
  type OverlayId,
  type StoreAction,
} from "../store-core.js";

/** Drains ink's async render scheduler the same way the primitives tests do. */
function drainInk(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 48));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Wraps <OverlayLayer /> and dispatches the given overlay id on mount, so the rendered
 * frame reflects the stack having the overlay on top. The harness pattern matches the
 * Phase 1 replayHarness — synchronous dispatch during render, guarded by a ref so it
 * fires exactly once even under React's strict-mode double-render.
 */
function OverlayHarness({ overlayId }: { overlayId: OverlayId }): React.ReactElement {
  const { dispatch } = useStore();
  const fired = useRef(false);
  if (!fired.current) {
    fired.current = true;
    dispatch({ type: "OVERLAY_PUSH", overlayId });
  }
  return <OverlayLayer />;
}

describe("selectIsBlockingModalOpen", () => {
  it("returns false when nothing blocking is open", () => {
    const state = buildInitialState({ model: "test-model", capUsd: 10 });
    expect(selectIsBlockingModalOpen(state)).toBe(false);
  });

  it("returns true when overlayStack has any entry", () => {
    const state = reducer(
      buildInitialState({ model: "test-model", capUsd: 10 }),
      { type: "OVERLAY_PUSH", overlayId: "model" }
    );
    expect(selectIsBlockingModalOpen(state)).toBe(true);
  });

  it("returns true when pendingApproval is set (independent of overlayStack)", () => {
    const state = reducer(
      buildInitialState({ model: "test-model", capUsd: 10 }),
      {
        type: "PENDING_APPROVAL_SET",
        approvalId: "a1",
        runId: "r1",
        command: "npm test",
        kind: "command",
      }
    );
    expect(selectIsBlockingModalOpen(state)).toBe(true);
  });

  it("returns true for pendingHookTrust / pendingMcpTrust / planProposal / planReadyProposal / stagedDiffProposal", () => {
    const base = buildInitialState({ model: "test-model", capUsd: 10 });
    const hookState = { ...base, pendingHookTrust: { config: {} as never, hash: "h", projectPath: "/p" } };
    expect(selectIsBlockingModalOpen(hookState)).toBe(true);
    const mcpState = { ...base, pendingMcpTrust: { config: {} as never, hash: "h", projectPath: "/p" } };
    expect(selectIsBlockingModalOpen(mcpState)).toBe(true);
    const planState = { ...base, planProposal: { revisionId: "r1", runId: "r", revisionType: "mixed" as const, revisionReason: "", originalPlan: "", revisedPlanSummary: "" } };
    expect(selectIsBlockingModalOpen(planState)).toBe(true);
    const planReadyState = { ...base, planReadyProposal: { planId: "p", runId: "r", objective: "", steps: [], riskHints: [], scopeSummary: "" } };
    expect(selectIsBlockingModalOpen(planReadyState)).toBe(true);
    const stagedState = { ...base, stagedDiffProposal: { approvalId: "a", runId: "r", files: [], verificationSummary: "", trigger: "" } };
    expect(selectIsBlockingModalOpen(stagedState)).toBe(true);
  });
});

describe("OVERLAY_PUSH / OVERLAY_POP / OVERLAY_CLEAR reducer", () => {
  it("push appends to the stack", () => {
    let state = buildInitialState({ model: "test-model", capUsd: 10 });
    state = reducer(state, { type: "OVERLAY_PUSH", overlayId: "model" });
    expect(state.overlayStack).toEqual(["model"]);
    state = reducer(state, { type: "OVERLAY_PUSH", overlayId: "keys" });
    expect(state.overlayStack).toEqual(["model", "keys"]);
  });

  it("pop removes only the top entry (stack semantics, not specific id)", () => {
    let state = buildInitialState({ model: "test-model", capUsd: 10 });
    state = reducer(state, { type: "OVERLAY_PUSH", overlayId: "model" });
    state = reducer(state, { type: "OVERLAY_PUSH", overlayId: "keys" });
    state = reducer(state, { type: "OVERLAY_POP" });
    expect(state.overlayStack).toEqual(["model"]);
  });

  it("pop on an empty stack is a no-op (does not throw, does not change state)", () => {
    const state = buildInitialState({ model: "test-model", capUsd: 10 });
    const next = reducer(state, { type: "OVERLAY_POP" });
    expect(next.overlayStack).toEqual([]);
    expect(next).toBe(state);
  });

  it("clear empties the whole stack", () => {
    let state = buildInitialState({ model: "test-model", capUsd: 10 });
    state = reducer(state, { type: "OVERLAY_PUSH", overlayId: "model" });
    state = reducer(state, { type: "OVERLAY_PUSH", overlayId: "keys" });
    state = reducer(state, { type: "OVERLAY_PUSH", overlayId: "metrics" });
    state = reducer(state, { type: "OVERLAY_CLEAR" });
    expect(state.overlayStack).toEqual([]);
  });

  it("push accepts any valid OverlayId (type-level guard: a typo here is a compile error)", () => {
    const ids: OverlayId[] = [
      "model", "keys", "metrics", "effort", "summary", "planMode",
      "session", "sessions", "permissions", "limits", "commit", "feedback", "undo",
    ];
    let state = buildInitialState({ model: "test-model", capUsd: 10 });
    for (const id of ids) {
      state = reducer(state, { type: "OVERLAY_PUSH", overlayId: id });
    }
    expect(state.overlayStack).toEqual(ids);
  });
});

describe("OverlayLayer rendering", () => {
  it("renders nothing when overlayStack is empty", async () => {
    const instance = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <OverlayLayer />
      </StoreProvider>
    );
    await drainInk();
    expect(stripAnsi(instance.lastFrame() ?? "")).toBe("");
    instance.unmount();
  });

  it("renders ModelPicker (title + content) when overlayStack top is 'model'", async () => {
    const instance = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <OverlayHarness overlayId="model" />
      </StoreProvider>
    );
    await drainInk();
    const frame = stripAnsi(instance.lastFrame() ?? "");
    // OverlayShell title (lowercased)
    expect(frame).toContain("model");
    // KeyHints footer from OverlayLayer
    expect(frame).toContain("Esc");
    expect(frame).toContain("close");
    instance.unmount();
  });

  it("renders ApiKeysManager when overlayStack top is 'keys'", async () => {
    const instance = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <OverlayHarness overlayId="keys" />
      </StoreProvider>
    );
    await drainInk();
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("api keys");
    // ApiKeysManager's view-mode body text
    expect(frame).toContain("keys.json");
    instance.unmount();
  });

  it("renders MetricsDashboard when overlayStack top is 'metrics'", async () => {
    const instance = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <OverlayHarness overlayId="metrics" />
      </StoreProvider>
    );
    await drainInk();
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("metrics");
    expect(frame).toContain("Period");
    instance.unmount();
  });

  it("returns null for an OverlayId that has no content component wired yet (Phase 2d)", async () => {
    // "effort" is on the OverlayId union but OverlayLayer's switch has no case for it.
    // Returning null (not throwing) is the contract — the rest of the UI must stay usable.
    const instance = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <OverlayHarness overlayId="effort" />
      </StoreProvider>
    );
    await drainInk();
    expect(stripAnsi(instance.lastFrame() ?? "")).toBe("");
    instance.unmount();
  });
});

// Silence the unused-import lint for StoreAction (the Harness's dispatch is typed via
// useStore's return, not the direct StoreAction type).
void (null as unknown as StoreAction);
