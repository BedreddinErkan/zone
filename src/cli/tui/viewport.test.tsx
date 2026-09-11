import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "./App.js";
import { createEventBus } from "../eventBus.js";

describe("Phase 7.5a — viewport-high layout", () => {
  it("hero renders when transcript is empty and idle", () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("a coding agent that");
    expect(frame).toContain("per-token billing");
    expect(frame).toContain("no limits");
    expect(frame).toContain("exact dollars per run");
    expect(frame).toContain("shift+tab mode");
    unmount();
  });

  it("hero contains the 6x4 logo", () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("█▀▀▀▀█");
    expect(frame).toContain("█▄▄▄▄█");
    unmount();
  });

  it("hero vanishes after first transcript entry", () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    // Before any events, hero should be visible
    expect(lastFrame() ?? "").toContain("a coding agent that");
    // Emit an event that produces a transcript entry
    bus.emit("agent_loop_start", {
      runId: "test",
      ts: Date.now(),
      type: "agent_loop_start",
      title: "test",
    });
    // Wait for React to process
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const frame = lastFrame() ?? "";
        // Hero should be gone now
        expect(frame).not.toContain("a coding agent that");
        unmount();
        resolve();
      }, 200);
    });
  });
});
