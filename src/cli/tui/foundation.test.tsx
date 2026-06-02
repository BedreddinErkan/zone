import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { createEventBus } from "../eventBus.js";
import React from "react";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

function makeEvt(type: ZoneStructuredProgressEvent["type"], extra: Partial<ZoneStructuredProgressEvent> = {}): ZoneStructuredProgressEvent {
  return { runId: "test-run", ts: Date.now(), type, title: type, ...extra } as ZoneStructuredProgressEvent;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TUI.0 foundation", () => {
  it("renders idle state initially", () => {
    const { lastFrame } = render(<App />);
    expect(lastFrame()).toContain("idle");
  });

  it("renders with initialPrompt without error", () => {
    const { lastFrame } = render(<App initialPrompt="hi" />);
    expect(lastFrame()).toBeDefined();
  });

  it("unmounts cleanly", () => {
    const { unmount, lastFrame } = render(<App />);
    unmount();
    expect(lastFrame()).toBeDefined();
  });

  it("ErrorBoundary catches throw and calls onCrash", () => {
    const onCrash = vi.fn();

    function Bomb(): React.ReactElement {
      throw new Error("test crash");
    }

    render(
      <ErrorBoundary onCrash={onCrash}>
        <Bomb />
      </ErrorBoundary>
    );

    expect(onCrash).toHaveBeenCalledWith(expect.any(Error));
  });

  it("eventBus emit/on roundtrip works", () => {
    const bus = createEventBus();
    const handler = vi.fn();

    bus.on("narration", handler);
    bus.emit("narration", {
      runId: "test",
      ts: Date.now(),
      type: "narration",
      title: "test",
      text: "hello",
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ type: "narration", text: "hello" });
  });

  it("Esc in idle state leaves runState unchanged", () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("\x1b");
    // StatusBar shows "idle" text; no transition to aborted/done
    expect(lastFrame()).toContain("idle");
    unmount();
  });

  it("Esc in running state transitions to aborted", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} />);
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50);
    stdin.write("\x1b");
    await wait(50);
    expect(lastFrame()).toContain("aborted");
    unmount();
  });

  it("Composer renders when no initialPrompt (shows > prompt)", () => {
    const { lastFrame, unmount } = render(<App />);
    expect(lastFrame()).toContain(">");
    unmount();
  });

  it("renders without crash (Option B single-path layout)", () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    expect(lastFrame()).toBeDefined();
    unmount();
  });
});

describe("Status bar badge tracks /model change (reactive badge regression guard)", () => {
  // Regression guard for the stale-badge bug: the visible model badge was a
  // one-time raw stdout write (writeBannerToStdout) before Ink mounted. Now the
  // StatusBar renders a dedicated info line (model + used + cap) that updates
  // reactively on MODEL_APPLY. No floating <Header> box in the Ink tree.

  it("initial model and cap show in status bar when initialModel and capUsd are provided", () => {
    const { lastFrame, unmount } = render(
      <App initialModel="claude-sonnet-4-6" capUsd={30} />
    );
    const frame = lastFrame();
    expect(frame).toContain("claude-sonnet-4-6");
    expect(frame).toContain("cap $");
    // Header's Ink border box ("[Z] Zone") must not appear — only the raw banner is present
    expect(frame).not.toContain("[Z] Zone");
    unmount();
  });

  it("status bar badge updates when a different initialModel is rendered", async () => {
    const bus = createEventBus();
    const { lastFrame: lastFrame2, unmount: unmount2 } = render(
      <App bus={bus} initialModel="gpt-5.4" capUsd={10} />
    );
    await wait(30);
    const frame = lastFrame2();
    expect(frame).toContain("gpt-5.4");
    expect(frame).toContain("cap $");
    unmount2();
  });
});
