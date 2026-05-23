import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { createEventBus } from "../eventBus.js";
import React from "react";

describe("TUI.0 foundation", () => {
  it("renders Zone (TUI) placeholder", () => {
    const { lastFrame } = render(<App />);
    expect(lastFrame()).toContain("Zone (TUI)");
  });

  it("renders with initialPrompt without error", () => {
    const { lastFrame } = render(<App initialPrompt="hi" />);
    expect(lastFrame()).toContain("Zone (TUI)");
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
});
