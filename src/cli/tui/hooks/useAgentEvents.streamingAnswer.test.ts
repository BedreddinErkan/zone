import { describe, it, expect } from "vitest";
import { computeStreamingAnswerUpdate, STREAMING_ANSWER_TAIL_CAP } from "./useAgentEvents.js";

const START = { buffer: "", key: null as string | null };

describe("computeStreamingAnswerUpdate", () => {
  it("first delta of a turn: buffer becomes the fragment, key becomes runId:iter", () => {
    const r = computeStreamingAnswerUpdate(START, { runId: "run-1", iter: 3, delta: "Hel" });
    expect(r.buffer).toBe("Hel");
    expect(r.key).toBe("run-1:3");
  });

  it("same runId+iter: appends", () => {
    const s1 = computeStreamingAnswerUpdate(START, { runId: "run-1", iter: 3, delta: "Hel" });
    const s2 = computeStreamingAnswerUpdate(s1, { runId: "run-1", iter: 3, delta: "lo" });
    expect(s2.buffer).toBe("Hello");
    expect(s2.key).toBe("run-1:3");
  });

  it("same runId, different iter (a genuinely new LLM turn): resets, does not append", () => {
    const s1 = computeStreamingAnswerUpdate(START, { runId: "run-1", iter: 3, delta: "preamble text" });
    const s2 = computeStreamingAnswerUpdate(s1, { runId: "run-1", iter: 5, delta: "The answer" });
    expect(s2.buffer).toBe("The answer");
    expect(s2.buffer).not.toContain("preamble");
  });

  it("same iter, different runId (two runs coincidentally sharing an iter number): resets — the case iter-alone would get wrong", () => {
    const s1 = computeStreamingAnswerUpdate(START, { runId: "run-A", iter: 1, delta: "leftover from run A" });
    const s2 = computeStreamingAnswerUpdate(s1, { runId: "run-B", iter: 1, delta: "run B's first fragment" });
    expect(s2.buffer).toBe("run B's first fragment");
    expect(s2.buffer).not.toContain("leftover");
  });

  it("continuation call sharing the main call's iter (by design, agentLoop.ts's own closure-reuse): appends across the boundary", () => {
    // agentLoop.ts deliberately reuses one onTextDelta closure across the main call and its
    // auto-continuation, so both carry the same iter — this is the scenario that makes that
    // sharing correct rather than a bug: the continuation is the same logical answer.
    const s1 = computeStreamingAnswerUpdate(START, { runId: "run-1", iter: 4, delta: "The answer is cut" });
    const s2 = computeStreamingAnswerUpdate(s1, { runId: "run-1", iter: 4, delta: " off mid-sentence, continued." });
    expect(s2.buffer).toBe("The answer is cut off mid-sentence, continued.");
  });

  it("tail cap: buffer never exceeds the cap, keeping only the most recent characters", () => {
    const cap = 10;
    let s = { buffer: "", key: null as string | null };
    s = computeStreamingAnswerUpdate(s, { runId: "run-1", iter: 1, delta: "0123456789" }, cap);
    expect(s.buffer).toBe("0123456789");
    s = computeStreamingAnswerUpdate(s, { runId: "run-1", iter: 1, delta: "ABC" }, cap);
    expect(s.buffer).toBe("3456789ABC");
    expect(s.buffer.length).toBe(cap);
  });

  it("default tail cap is the exported STREAMING_ANSWER_TAIL_CAP constant, not a re-guessed literal", () => {
    const long = "x".repeat(STREAMING_ANSWER_TAIL_CAP + 500);
    const s = computeStreamingAnswerUpdate(START, { runId: "run-1", iter: 1, delta: long });
    expect(s.buffer.length).toBe(STREAMING_ANSWER_TAIL_CAP);
  });

  it("missing iter/runId (defensive — should not throw or silently accumulate forever under one blank key)", () => {
    const s1 = computeStreamingAnswerUpdate(START, { delta: "no runId or iter" });
    expect(s1.key).toBe(":");
    expect(s1.buffer).toBe("no runId or iter");
  });

  it("empty delta: still computes a defined result (the caller's own guard, not this function's job, skips zero-length fragments before calling)", () => {
    const s = computeStreamingAnswerUpdate(START, { runId: "run-1", iter: 1, delta: "" });
    expect(s.buffer).toBe("");
    expect(s.key).toBe("run-1:1");
  });

  // Negative control: a change that should NOT affect the reset decision.
  it("negative control — delta content itself never influences the reset decision, only runId+iter do", () => {
    const s1 = computeStreamingAnswerUpdate(START, { runId: "run-1", iter: 1, delta: "reset-looking text: NEW TURN" });
    const s2 = computeStreamingAnswerUpdate(s1, { runId: "run-1", iter: 1, delta: " more" });
    expect(s2.buffer).toBe("reset-looking text: NEW TURN more");
  });
});
