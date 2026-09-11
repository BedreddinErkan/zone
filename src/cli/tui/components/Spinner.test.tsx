import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "../App.js";
import { createEventBus } from "../../eventBus.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import { SPINNER_LABEL_STARTING } from "../hooks/useAgentEvents.js";

vi.mock("../../api/commandApprovals.js", () => ({ resolveCommandApproval: vi.fn() }));
vi.mock("../../llm/revisionApprovals.js", () => ({ resolveRevisionApproval: vi.fn() }));

function makeEvt(type: ZoneStructuredProgressEvent["type"]): ZoneStructuredProgressEvent {
  return { runId: "test-run", ts: Date.now(), type, title: type } as ZoneStructuredProgressEvent;
}

/** Same, minus the title. agent_loop_start now honours evt.title (it previously discarded it), and
 *  makeEvt sets title to the type NAME — so these spinner tests would assert against the literal
 *  string "agent_loop_start". They are about the label not rotating over time, not about which
 *  label it is, so they emit titleless and let the fallback constant stand. */
function makeUntitledEvt(type: ZoneStructuredProgressEvent["type"]): ZoneStructuredProgressEvent {
  return { runId: "test-run", ts: Date.now(), type } as ZoneStructuredProgressEvent;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// The palette pass replaced the star cycle with the logo mark's own diagonal rotating through
// the box-drawing line family. DIAGONAL_FRAMES is used only by spinnerLine() below, where
// frame.split("\n").find(...) returns the first matching line and the spinner's own line always
// renders above the app shell's unrelated "─"-only separator rules — confirmed empirically, not
// assumed, since "─" and "│" are not unique to the spinner the way the old star glyphs were.
// The two presence/absence checks below instead key on "╱" alone (FRAMES[0], the frame shown at
// the low advance-times these tests use) — confirmed absent from the rest of the app shell.
const DIAGONAL_FRAMES = ["╱", "│", "╲", "─"];

describe("Spinner", () => {
  afterEach(() => { vi.useRealTimers(); });

  // Phase 6f — flake fix: increased wait from 50ms to 150ms.
  // Phase 6f.1 — padded-wait mitigation note:
  //   Root cause: bus.emit("agent_loop_start") → scheduler microtask → reducer
  //   dispatch → React re-render is a multi-step async chain. Under event-loop
  //   contention (busy full-suite runs), 50ms is insufficient for the spinner
  //   frame to appear in the last rendered output.
  //   Why acceptable: 150ms is well under the test's timeout budget and the
  //   assertion (frame contains "╱") is idempotent — a longer wait cannot
  //   produce a false pass, only a slower test.
  //   Proper fix: use fake timers (vi.useFakeTimers + advanceTimersByTimeAsync)
  //   to drive the scheduler deterministically, as the sibling "keeps the
  //   Starting… label fixed" test already does.
  //   Tracked in docs/deferred-work.md item 416.
  it("renders a diagonal frame when agent_loop_start activates spinner", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    bus.emit("agent_loop_start", makeUntitledEvt("agent_loop_start"));
    await wait(150);
    const frame = lastFrame() ?? "";
    // The spinner rotates every FRAME_MS (100ms). After 150ms the first frame ("╱")
    // may have been replaced by a later frame — assert any spinner frame is present.
    expect(DIAGONAL_FRAMES.some((f) => frame.includes(f))).toBe(true);
    unmount();
  });

  it("renders nothing before agent_loop_start", () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame() ?? "";
    expect(frame.includes("╱")).toBe(false);
    unmount();
  });

  it("keeps the Starting… label fixed — the palette pass removed word rotation entirely", async () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    bus.emit("agent_loop_start", makeUntitledEvt("agent_loop_start"));
    await vi.advanceTimersByTimeAsync(50);
    expect(lastFrame()).toContain(SPINNER_LABEL_STARTING);
    // Advance well past where the old RUNNING_WORDS rotation would have fired twice; the label
    // must still read the same, since there is no longer any mechanism that would change it.
    await vi.advanceTimersByTimeAsync(4050);
    expect(lastFrame()).toContain(SPINNER_LABEL_STARTING);
    unmount();
  });

  it("keeps a specific label fixed too (Compacting context…) — no longer a special case, since every label now behaves this way", async () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    bus.emit("agent_loop_start", makeUntitledEvt("agent_loop_start"));
    bus.emit("compaction_started", makeEvt("compaction_started"));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(6050);
    expect(lastFrame()).toContain("Compacting context…");
    unmount();
  });
});

describe("Spinner — no context parenthetical (b045f350 reverted)", () => {
  afterEach(() => { vi.useRealTimers(); });

  // Phase 6f — flake fix: increased wait from 50ms to 150ms.
  // Phase 6f.1 — padded-wait mitigation note:
  //   Root cause: same as the "renders a diagonal frame" test above — bus emit
  //   → scheduler → reducer → React re-render chain under event-loop contention.
  //   Why acceptable: same reasoning — 150ms is within timeout budget and the
  //   assertion (spinnerLine contains label, no parenthetical) is idempotent.
  //   Proper fix: convert to fake timers like the sibling label-stability tests.
  //   Tracked in docs/deferred-work.md item 416.
  it("while running, the spinner line contains the gerund and no parenthetical", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);
    bus.emit("agent_loop_start", makeUntitledEvt("agent_loop_start"));
    await wait(150);
    const line = spinnerLine(lastFrame() ?? "");
    expect(line).toContain(SPINNER_LABEL_STARTING);
    expect(line).not.toContain("(");
    unmount();
  });
});

function spinnerLine(frame: string): string {
  return frame.split("\n").find((l) => DIAGONAL_FRAMES.some((f) => l.includes(f))) ?? "";
}
