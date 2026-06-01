import { describe, it, expect } from "vitest";
import type { StoreAction } from "../store.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import {
  formatCompactionNarration,
  handleCompactionStarted,
  handleCompactionStatus,
  handleCompactionExhausted,
  handleCompactionOverflow,
} from "./useAgentEvents.js";

function capture(): { calls: StoreAction[]; dispatch: (a: StoreAction) => void } {
  const calls: StoreAction[] = [];
  return { calls, dispatch: (a) => { calls.push(a); } };
}

describe("Compact.3: formatCompactionNarration", () => {
  it("humanizes token counts and computes savings pct", () => {
    const text = formatCompactionNarration({
      tokensBefore: 50000,
      tokensAfter: 15000,
      savedTokens: 35000,
      count: 1,
    });
    expect(text).toBe("Context compacted: ~50k → ~15k tokens (−70%, #1)");
  });
});

describe("Compact.3: handlers", () => {
  it("handleCompactionStarted dispatches SPINNER_UPDATE", () => {
    const { calls, dispatch } = capture();
    handleCompactionStarted(
      { type: "compaction_started", count: 1 } as ZoneStructuredProgressEvent,
      dispatch
    );
    expect(calls).toEqual([{ type: "SPINNER_UPDATE", label: "Compacting context…" }]);
  });

  it("handleCompactionStatus dispatches SPINNER_STOP → narration → NARRATION_COMMIT", () => {
    const { calls, dispatch } = capture();
    handleCompactionStatus({
      type: "compaction_status",
      count: 1,
      tokensBefore: 50000,
      tokensAfter: 15000,
      savedTokens: 35000,
    } as ZoneStructuredProgressEvent, dispatch);
    expect(calls[0]).toEqual({ type: "SPINNER_STOP" });
    expect(calls[1]).toEqual({
      type: "TRANSCRIPT_APPEND_NARRATION",
      text: "Context compacted: ~50k → ~15k tokens (−70%, #1)",
    });
    expect(calls[2]).toEqual({ type: "NARRATION_COMMIT" });
  });

  it("handleCompactionExhausted dispatches SPINNER_STOP + TOAST_PUSH warning", () => {
    const { calls, dispatch } = capture();
    handleCompactionExhausted({
      type: "compaction_exhausted",
      message: "Context exhausted. Break this task into subtasks.",
    } as ZoneStructuredProgressEvent, dispatch);
    expect(calls[0]).toEqual({ type: "SPINNER_STOP" });
    expect(calls[1]).toMatchObject({
      type: "TOAST_PUSH",
      entry: {
        message: "Context exhausted. Break this task into subtasks.",
        level: "warning",
      },
    });
  });

  it("handleCompactionOverflow dispatches SPINNER_STOP + TOAST_PUSH(warning)", () => {
    const { calls, dispatch } = capture();
    handleCompactionOverflow({}, dispatch);
    expect(calls[0]).toEqual({ type: "SPINNER_STOP" });
    expect(calls[1]).toMatchObject({
      type: "TOAST_PUSH",
      entry: {
        message: "Context window full — no history to compact",
        level: "warning",
      },
    });
  });
});
