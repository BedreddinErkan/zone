import { describe, it, expect } from "vitest";
import { renderTranscriptAt } from "./__fixtures__/staticHarness.js";
import { STREAMING_ANSWER_TAIL_CAP } from "./hooks/useAgentEvents.js";

// Gates the rollout decision (S4): the live streamingAnswer region sits outside <Static> and
// is re-rendered by Ink every frame. This measures render cost at the proposed tail cap and at
// 2x it (negative control — if 2x is not proportionally worse, the cap is not the bottleneck).
// No provider call, no Zone run — L1, synthetic state only.

function timeRenderAt(chars: number, columns: number): number {
  const text = "The answer keeps streaming in, one fragment at a time. ".repeat(
    Math.ceil(chars / 57)
  ).slice(0, chars);
  const start = performance.now();
  const h = renderTranscriptAt([], columns, text);
  const frame = h.lastFrame();
  const elapsed = performance.now() - start;
  h.unmount();
  expect(frame).toContain(text.slice(0, 40));
  return elapsed;
}

describe("streamingAnswer frame-cost measurement (gates rollout — report the numbers, not just pass/fail)", () => {
  it("renders at the proposed cap (2,000 chars) well under a pathological threshold, at both narrow and wide columns", () => {
    const at80 = timeRenderAt(STREAMING_ANSWER_TAIL_CAP, 80);
    const at60 = timeRenderAt(STREAMING_ANSWER_TAIL_CAP, 60);
    // eslint-disable-next-line no-console
    console.log(`[frame-cost] cap=${STREAMING_ANSWER_TAIL_CAP} cols=80: ${at80.toFixed(2)}ms, cols=60: ${at60.toFixed(2)}ms`);
    expect(at80).toBeLessThan(200);
    expect(at60).toBeLessThan(200);
  });

  it("renders at 2x the cap (4,000 chars, negative control) — reports whether cost scales proportionally or worse", () => {
    const atCap = timeRenderAt(STREAMING_ANSWER_TAIL_CAP, 80);
    const at2x = timeRenderAt(STREAMING_ANSWER_TAIL_CAP * 2, 80);
    // eslint-disable-next-line no-console
    console.log(
      `[frame-cost] cap=${STREAMING_ANSWER_TAIL_CAP}: ${atCap.toFixed(2)}ms, ` +
      `2x=${STREAMING_ANSWER_TAIL_CAP * 2}: ${at2x.toFixed(2)}ms, ` +
      `ratio: ${(at2x / Math.max(atCap, 0.01)).toFixed(2)}x`
    );
    expect(at2x).toBeLessThan(400);
  });

  it("negative control — an empty streamingAnswer renders with no measurable region (sanity check on the measurement itself)", () => {
    const h = renderTranscriptAt([], 80, "");
    expect(h.lastFrame() ?? "").not.toContain("The answer keeps streaming");
    h.unmount();
  });
});
