/**
 * Phase 6.B — sweep harness fetch timeout unit test.
 *
 * Verifies that dispatchTask throws a descriptive timeout error (not a generic
 * "fetch failed" error) when the request exceeds the configured timeout, and
 * that the error message includes the task id and runId for log correlation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { SweepTask } from "./sweep.js";
import { dispatchTask } from "./sweep.js";

// Signal-aware fetch mock: hangs until AbortController fires, then rejects.
const hangingFetch = (_url: string, opts?: RequestInit): Promise<Response> =>
  new Promise<Response>((_, reject) => {
    opts?.signal?.addEventListener("abort", () => {
      reject(
        Object.assign(new Error("The operation was aborted."), { name: "AbortError" })
      );
    });
    // No resolve path — this fetch never completes on its own.
  });

const mockTask: SweepTask = {
  id: "t1",
  tier_expected: "simple",
  description: "add a comment to a function",
  expected_max_cost_usd: 0.1,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dispatchTask fetch timeout (Phase 6.B)", () => {
  it("times out and includes task id + runId in error message", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch);

    const promise = dispatchTask(mockTask, 500); // 500 ms timeout

    // Attach rejection handler BEFORE advancing timers so the rejection is never
    // unhandled. Node.js emits unhandledRejection during the microtask drain
    // inside advanceTimersByTimeAsync — attaching .catch() first prevents that.
    const caught = promise.catch((e: unknown) => e as Error);

    // Advance fake time to fire the AbortController timeout.
    await vi.advanceTimersByTimeAsync(501);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("timed out after 0.5s");
    expect((err as Error).message).toContain("t1");
    expect((err as Error).message).toContain("runId=sweep-t1-");
  });

  it("does not timeout when fetch completes before the deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, costUsd: 0.01, decisionMode: "applied", fileDiffs: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await dispatchTask(mockTask, 5000);
    expect(result.taskId).toBe("t1");
    expect(result.decisionMode).toBe("applied");
    expect(result.errorMessage).toBe("");
  });
});
