import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "../App.js";
import { createEventBus } from "../../eventBus.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import { SPINNER_LABEL_STARTING } from "../hooks/useAgentEvents.js";
import { LABEL_ROTATE_MS, RUNNING_WORDS } from "./Spinner.js";

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

  it("rotates Starting… label through RUNNING_WORDS after each LABEL_ROTATE_MS tick", async () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await vi.advanceTimersByTimeAsync(50);
    expect(lastFrame()).toContain(RUNNING_WORDS[0]); // "Starting…" = SPINNER_LABEL_STARTING
    await vi.advanceTimersByTimeAsync(LABEL_ROTATE_MS + 50);
    expect(lastFrame()).toContain(RUNNING_WORDS[1]); // "Working…"
    await vi.advanceTimersByTimeAsync(LABEL_ROTATE_MS);
    expect(lastFrame()).toContain(RUNNING_WORDS[2]); // "Crafting…"
    unmount();
  });

  it("does not rotate a non-rotatable label (Compacting context…)", async () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    bus.emit("compaction_started", makeEvt("compaction_started"));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(LABEL_ROTATE_MS * 3 + 50);
    expect(lastFrame()).toContain("Compacting context…");
    unmount();
  });
});

describe("Spinner — no context parenthetical (b045f350 reverted)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("while running, the spinner line contains the gerund and no parenthetical", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50);
    const line = spinnerLine(lastFrame() ?? "");
    expect(line).toContain(RUNNING_WORDS[0]); // "Starting…"
    expect(line).not.toContain("(");
    unmount();
  });
});

function spinnerLine(frame: string): string {
  return frame.split("\n").find((l) => STAR_FRAMES.some((f) => l.includes(f))) ?? "";
}
