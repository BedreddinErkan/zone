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
  it("renders Zone placeholder", () => {
    const { lastFrame } = render(<App />);
    expect(lastFrame()).toContain("Zone");
  });

  it("renders with initialPrompt without error", () => {
    const { lastFrame } = render(<App initialPrompt="hi" />);
    expect(lastFrame()).toContain("Zone");
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

  it("gate-on layout: renders without crash when ZONE_EXPERIMENTAL_STATIC=1", () => {
    const original = process.env.ZONE_EXPERIMENTAL_STATIC;
    process.env.ZONE_EXPERIMENTAL_STATIC = "1";
    try {
      const bus = createEventBus();
      const { lastFrame, unmount } = render(<App bus={bus} />);
      expect(lastFrame()).toBeDefined();
      unmount();
    } finally {
      process.env.ZONE_EXPERIMENTAL_STATIC = original;
    }
  });
});
