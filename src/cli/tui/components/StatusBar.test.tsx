import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React, { useEffect } from "react";
import { StoreProvider, useStore } from "../store.js";
import type { StoreAction } from "../store.js";
import { StatusBar } from "./StatusBar.js";
import type { DiskModelSettings } from "../../../api/diskModel.js";

function renderStatusBar(modelSettings: DiskModelSettings | null) {
  return render(
    <StoreProvider initialValues={{ model: "test-model", capUsd: 10, modelSettings }}>
      <StatusBar />
    </StoreProvider>
  );
}

describe("StatusBar — effort badge", () => {
  it("shows effort when modelSettings.effort is set", () => {
    const { lastFrame, unmount } = renderStatusBar({
      version: 2,
      model: "test-model",
      provider: "anthropic",
      effort: "high",
      updatedAt: new Date().toISOString(),
    });
    expect(lastFrame()).toContain("effort: high");
    unmount();
  });

  it("omits the effort segment when modelSettings.effort is not set (model doesn't support it)", () => {
    const { lastFrame, unmount } = renderStatusBar({
      version: 2,
      model: "test-model",
      provider: "anthropic",
      updatedAt: new Date().toISOString(),
    });
    expect(lastFrame()).not.toContain("effort:");
    unmount();
  });

  it("omits the effort segment when modelSettings itself is null", () => {
    const { lastFrame, unmount } = renderStatusBar(null);
    expect(lastFrame()).not.toContain("effort:");
    unmount();
  });
});

describe("StatusBar — live elapsed-time ticker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function Harness({
    captureDispatch,
  }: {
    captureDispatch: (d: (a: StoreAction) => void) => void;
  }): React.ReactElement {
    const { dispatch } = useStore();
    useEffect(() => {
      captureDispatch(dispatch);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <StatusBar />;
  }

  function renderLive() {
    let dispatch!: (a: StoreAction) => void;
    const { lastFrame, unmount } = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <Harness captureDispatch={(d) => { dispatch = d; }} />
      </StoreProvider>
    );
    return { lastFrame, unmount, dispatch: (a: StoreAction) => dispatch(a) };
  }

  it("elapsed increments while running", async () => {
    vi.useFakeTimers();
    const { lastFrame, unmount, dispatch } = renderLive();
    dispatch({ type: "SPINNER_START", label: "Working" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toContain("0.0s");
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastFrame()).toContain("3.0s");
    unmount();
  });

  it("does not advance while awaiting_input — no ticking elapsed figure during a park", async () => {
    vi.useFakeTimers();
    const { lastFrame, unmount, dispatch } = renderLive();
    dispatch({ type: "SPINNER_START", label: "Working" });
    // Flush once so the ticker's useEffect registers its interval before the
    // big jump below — advancing straight from 0 can start consuming virtual
    // time before React's effect has run, same as the first test's own flush.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(lastFrame()).toContain("2.0s");

    dispatch({ type: "USER_QUESTION_ASKED", questionId: "q1", runId: "r1", question: "Which approach?" });
    await vi.advanceTimersByTimeAsync(3000);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("waiting for you");
    expect(frame).not.toMatch(/\d+\.\ds/);
    unmount();
  });
});
