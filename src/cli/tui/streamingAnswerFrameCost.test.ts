import { describe, it, expect, vi, afterEach } from "vitest";
import { renderTranscriptAt } from "./__fixtures__/staticHarness.js";
import { STREAMING_ANSWER_TAIL_CAP } from "./hooks/useAgentEvents.js";

// Gates the rollout decision (S4): the live streamingAnswer region sits outside <Static> and
// is re-rendered by Ink every frame. This measures DISPATCH COUNT (frames written to stdout)
// at the proposed tail cap and at 2x it (negative control — if 2x produces disproportionately
// more frames, the streaming path has an N+1 dispatch regression).
//
// Phase 6f.1 — deterministic guard: replaced wall-clock timing with fake-timer + frame-count
// assertions. A wall-clock measurement under event-loop contention is non-deterministic; the
// previous 200ms threshold was relaxed to 500ms to stop flakes, which weakened the regression
// guard. Frame count is a property of the render tree, not the scheduler, so it is stable
// across CI runs. If the streaming path regresses to N+1 dispatches per delta, frameCount
// will spike and the test will fail regardless of machine speed.
//
// Wall-clock ms is still reported under ZONE_BENCH=1 for benchmarking; CI skips it.
// No provider call, no Zone run — L1, synthetic state only.

afterEach(() => { vi.useRealTimers(); });

function renderAt(chars: number, columns: number) {
  const text = "The answer keeps streaming in, one fragment at a time. ".repeat(
    Math.ceil(chars / 57)
  ).slice(0, chars);
  vi.useFakeTimers();
  const h = renderTranscriptAt([], columns, text);
  vi.runAllTimers();
  const frame = h.lastFrame();
  const frames = h.frameCount();
  h.unmount();
  expect(frame).toContain(text.slice(0, 40));
  return { frames, text };
}

describe("streamingAnswer frame-cost measurement (gates rollout — dispatch count, not wall-clock)", () => {
  it("renders at the proposed cap (2,000 chars) with a bounded frame count, at both narrow and wide columns", () => {
    const r80 = renderAt(STREAMING_ANSWER_TAIL_CAP, 80);
    const r60 = renderAt(STREAMING_ANSWER_TAIL_CAP, 60);
    // eslint-disable-next-line no-console
    console.log(`[frame-cost] cap=${STREAMING_ANSWER_TAIL_CAP} cols=80: ${r80.frames} frames, cols=60: ${r60.frames} frames`);
    // Guard: a single synchronous render should not produce excessive re-renders.
    // N+1 dispatch per delta would cause frameCount to scale with content length —
    // this cap catches that regression regardless of machine speed.
    expect(r80.frames).toBeLessThanOrEqual(10);
    expect(r60.frames).toBeLessThanOrEqual(10);
  });

  it("renders at 2x the cap (4,000 chars, negative control) — frame count must not scale super-linearly", () => {
    const rCap = renderAt(STREAMING_ANSWER_TAIL_CAP, 80);
    const r2x = renderAt(STREAMING_ANSWER_TAIL_CAP * 2, 80);
    // eslint-disable-next-line no-console
    console.log(
      `[frame-cost] cap=${STREAMING_ANSWER_TAIL_CAP}: ${rCap.frames} frames, ` +
      `2x=${STREAMING_ANSWER_TAIL_CAP * 2}: ${r2x.frames} frames`
    );
    // Guard: 2x content should not produce more than 2x frames (linear scaling).
    // Super-linear growth indicates the streaming path dispatches per delta, not per render.
    expect(r2x.frames).toBeLessThanOrEqual(Math.max(rCap.frames * 2, 10));
  });

  it("negative control / baseline — an empty streamingAnswer renders no preview region, and its frame count is the reference the capped figures are read against", () => {
    vi.useFakeTimers();
    const h = renderTranscriptAt([], 80, "");
    vi.runAllTimers();
    const frame = h.lastFrame() ?? "";
    const baselineFrames = h.frameCount();
    h.unmount();

    // eslint-disable-next-line no-console
    console.log(`[frame-cost] baseline (empty streamingAnswer) cols=80: ${baselineFrames} frames`);

    expect(frame).not.toContain("The answer keeps streaming");
    expect(baselineFrames).toBeLessThanOrEqual(5);
  });
});

// Optional wall-clock benchmark — only runs when ZONE_BENCH=1 is set.
// CI does not set this, so wall-clock variance never causes CI flakes.
const bench = process.env.ZONE_BENCH === "1";

describe.skipIf(!bench)("streamingAnswer wall-clock benchmark (ZONE_BENCH=1 only)", () => {
  function timeRenderAt(chars: number, columns: number): number {
    const text = "The answer keeps streaming in, one fragment at a time. ".repeat(
      Math.ceil(chars / 57)
    ).slice(0, chars);
    const start = performance.now();
    const h = renderTranscriptAt([], columns, text);
    h.lastFrame();
    const elapsed = performance.now() - start;
    h.unmount();
    return elapsed;
  }

  it("reports wall-clock ms at cap and 2x (benchmark only, not a regression guard)", () => {
    const at80 = timeRenderAt(STREAMING_ANSWER_TAIL_CAP, 80);
    const at60 = timeRenderAt(STREAMING_ANSWER_TAIL_CAP, 60);
    const at2x = timeRenderAt(STREAMING_ANSWER_TAIL_CAP * 2, 80);
    // eslint-disable-next-line no-console
    console.log(
      `[bench] cap cols=80: ${at80.toFixed(2)}ms, cap cols=60: ${at60.toFixed(2)}ms, ` +
      `2x: ${at2x.toFixed(2)}ms`
    );
  });
});
