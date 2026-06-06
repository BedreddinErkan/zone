/**
 * Finding 3: the status-line "duration" must measure per-task execution time
 * (task begin → task complete), not session lifetime. The pre-fix reducer
 * captured runStartMs once on the first task (`?? Date.now()`) and never reset
 * it, so durations grew monotonically across a session (116 → 532 → 1276 …).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { reducer, buildInitialState } from "./store.js";

function durationSec(s: { runStartMs?: number; runEndMs?: number }): number {
  return (s.runEndMs! - s.runStartMs!) / 1000;
}

describe("run duration is per-task (Finding 3)", () => {
  afterEach(() => vi.useRealTimers());

  it("measures each task from its own start and freezes at completion", () => {
    vi.useFakeTimers();
    let s = buildInitialState({ model: "m", capUsd: 10 });

    // Task 1: begins at t=1000ms.
    vi.setSystemTime(1000);
    s = reducer(s, { type: "SPINNER_START", label: "Starting…" });
    expect(s.runStartMs).toBe(1000);

    // A mid-run spinner relabel must NOT move the start.
    vi.setSystemTime(50_000);
    s = reducer(s, { type: "SPINNER_UPDATE", label: "Working…" });
    expect(s.runStartMs).toBe(1000);

    // Completes 116s after its own start.
    vi.setSystemTime(117_000);
    s = reducer(s, { type: "RUN_DONE" });
    expect(s.runEndMs).toBe(117_000);
    expect(durationSec(s)).toBe(116);

    // The user reads the result for ~8 minutes (idle, status stays "done").
    vi.setSystemTime(600_000);

    // Task 2: a trivial edit begins much later and takes only 10s.
    s = reducer(s, { type: "SPINNER_START", label: "Starting…" });
    expect(s.runStartMs).toBe(600_000); // reset to ITS start, not 1000
    expect(s.runEndMs).toBeUndefined(); // prior end cleared
    vi.setSystemTime(610_000);
    s = reducer(s, { type: "RUN_DONE" });

    // Pre-fix this reported (610000-1000)/1000 = 609s; now it is the real 10s.
    expect(durationSec(s)).toBe(10);
  });

  it("keeps runStartMs stable across a mid-run (subagent) SPINNER_START", () => {
    vi.useFakeTimers();
    let s = buildInitialState({ model: "m", capUsd: 10 });
    vi.setSystemTime(1000);
    s = reducer(s, { type: "SPINNER_START", label: "Starting…" });
    vi.setSystemTime(5000);
    // A second SPINNER_START while already running must not reset the timer.
    s = reducer(s, { type: "SPINNER_START", label: "Subagent…" });
    expect(s.runStartMs).toBe(1000);
  });

  it("resets the timer on session resume", () => {
    vi.useFakeTimers();
    let s = buildInitialState({ model: "m", capUsd: 10 });
    vi.setSystemTime(1000);
    s = reducer(s, { type: "SPINNER_START", label: "Starting…" });
    s = reducer(s, { type: "RUN_DONE" });
    s = reducer(s, {
      type: "SESSION_RESUME",
      session: {
        version: 1,
        sessionId: "abc",
        startedAt: new Date(0).toISOString(),
        lastActivityAt: new Date(0).toISOString(),
        cwd: "/repo",
        model: "m",
        transcript: [],
        totalCostUsd: 0,
        totalTokens: 0,
        totalElapsedMs: 0,
      },
    });
    expect(s.runStartMs).toBeUndefined();
    expect(s.runEndMs).toBeUndefined();
  });
});
