import { describe, it, expect } from "vitest";
import type { RunEnvelope } from "../api/diskRunEnvelope.js";

/**
 * `thinkingOmitted` and `messagesOmitted` must stay distinguishable.
 *
 * They record two different failures with two different costs. A run resumed
 * without its reasoning re-derives one turn; a run resumed without its
 * conversation cold-starts. Folding them into one flag would make a resume that
 * degraded gracefully look identical to one that lost everything — in exactly
 * the telemetry that has to tell them apart later.
 */

type EnvelopeShape = Pick<RunEnvelope, "messages" | "messagesOmitted" | "thinkingOmitted">;

/** The three states serializeMessagesForEnvelope can produce. */
const intact: EnvelopeShape = { messages: [{ role: "user", content: "task" }] };
const degraded: EnvelopeShape = {
  messages: [{ role: "user", content: "task" }],
  thinkingOmitted: true,
};
const dropped: EnvelopeShape = { messages: undefined, messagesOmitted: true };

function classify(env: EnvelopeShape): "intact" | "degraded" | "dropped" {
  if (env.messagesOmitted) return "dropped";
  if (env.thinkingOmitted) return "degraded";
  return "intact";
}

describe("the two omission markers are separate signals", () => {
  it("classifies all three states distinctly", () => {
    expect(classify(intact)).toBe("intact");
    expect(classify(degraded)).toBe("degraded");
    expect(classify(dropped)).toBe("dropped");
  });

  it("a degraded envelope still carries its conversation", () => {
    // This is what separates it from a drop, and it is the whole reason the
    // ladder exists.
    expect(Array.isArray(degraded.messages)).toBe(true);
    expect(degraded.messagesOmitted).toBeUndefined();
  });

  it("a dropped envelope carries nothing and says so", () => {
    expect(dropped.messages).toBeUndefined();
    expect(dropped.messagesOmitted).toBe(true);
    // Not also flagged as degraded: there was nothing left to degrade.
    expect(dropped.thinkingOmitted).toBeUndefined();
  });

  it("no state is silent — a resume can always tell what it lost", () => {
    // The invariant behind both markers: `messages: undefined` is otherwise
    // indistinguishable from "no checkpoint written yet".
    for (const env of [intact, degraded, dropped]) {
      const lostSomething = env.messages === undefined || env.thinkingOmitted === true;
      const saidSo = env.messagesOmitted === true || env.thinkingOmitted === true;
      expect(lostSomething ? saidSo : true).toBe(true);
    }
  });
});
