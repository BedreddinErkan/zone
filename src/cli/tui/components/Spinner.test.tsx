import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "../App.js";
import { createEventBus } from "../../eventBus.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";

vi.mock("../../api/commandApprovals.js", () => ({ resolveCommandApproval: vi.fn() }));
vi.mock("../../llm/revisionApprovals.js", () => ({ resolveRevisionApproval: vi.fn() }));

function makeEvt(type: ZoneStructuredProgressEvent["type"]): ZoneStructuredProgressEvent {
  return { runId: "test-run", ts: Date.now(), type, title: type } as ZoneStructuredProgressEvent;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const STAR_FRAMES = ["✦", "✧", "✶", "✷", "✸", "✹", "✺"];

describe("Spinner", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("renders a star frame when agent_loop_start activates spinner", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50);
    const frame = lastFrame() ?? "";
    expect(STAR_FRAMES.some((f) => frame.includes(f))).toBe(true);
    unmount();
  });

  it("renders nothing before agent_loop_start", () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame() ?? "";
    expect(STAR_FRAMES.some((f) => frame.includes(f))).toBe(false);
    unmount();
  });
});
