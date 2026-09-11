import { render } from "ink-testing-library";
import React, { useEffect, useRef } from "react";
import { StoreProvider, useStore } from "../store.js";
import { Transcript } from "../components/Transcript.js";
import { eventToActions, type EventCtx } from "../hooks/eventToActions.js";
import type { ZoneStructuredProgressEvent } from "../../../core/agentLifecycleEvents.js";
import type { StoreAction } from "../store-core.js";

export type HarnessInstance = {
  lastFrame: () => string;
  unmount: () => void;
};

/**
 * Extended replay event union. Any event whose type matches a
 * ZoneStructuredProgressEvent discriminator routes through eventToActions.
 * The rest are harness-local virtual events that synthesize actions directly,
 * covering the pieces of the dispatch surface that production intercepts
 * *before* eventToActions:
 *   - narration coalescing (handleTextEvent debounces into TRANSCRIPT_APPEND_NARRATION
 *     + NARRATION_COMMIT; in the replay harness we commit each fragment verbatim)
 *   - streaming_answer_delta (useAgentEvents debounces STREAMING_ANSWER_SET;
 *     we set it wholesale)
 *   - transcript_remount (TUI-only synthetic event fired on SIGWINCH — never on
 *     the event bus)
 *   - approval_granted (resolves a parked PENDING_APPROVAL_SET without routing
 *     through the approval registry)
 */
type VirtualReplayEvent =
  | { type: "narration"; runId?: string; text?: string; title?: string; ts?: number }
  | { type: "streaming_answer_delta"; runId?: string; text?: string; ts?: number }
  | { type: "transcript_remount"; runId?: string; ts?: number }
  | { type: "approval_granted"; runId?: string; approvalId?: string; ts?: number }
  | { type: "boot"; runId?: string; ts?: number; boot: import("../store-core.js").BootData };

type ReplayEvent = ZoneStructuredProgressEvent | VirtualReplayEvent;

const eventCtx: EventCtx = { trustedPrefixes: [], mode: "normal" };

function actionsForEvent(evt: ReplayEvent): StoreAction[] {
  switch (evt.type) {
    case "narration": {
      const text = (evt as { text?: string }).text ?? (evt as { title?: string }).title ?? "";
      if (!text) return [];
      // Production commits narration via NARRATION_COMMIT at the next tool-call
      // boundary; for deterministic replay we commit each fragment inline so
      // the reduced state is a stable function of event order, not of the
      // debounce timer.
      return [
        { type: "TRANSCRIPT_APPEND_NARRATION", text },
        { type: "NARRATION_COMMIT" },
      ];
    }
    case "streaming_answer_delta": {
      const text = (evt as { text?: string }).text ?? "";
      return text ? [{ type: "STREAMING_ANSWER_SET", text }] : [];
    }
    case "transcript_remount":
      return [{ type: "TRANSCRIPT_REMOUNT" }];
    case "approval_granted":
      return [{ type: "PENDING_APPROVAL_RESOLVED" }];
    case "boot":
      return [{ type: "BOOT_SET", boot: (evt as { boot: import("../store-core.js").BootData }).boot }];
    default:
      return eventToActions(evt as ZoneStructuredProgressEvent, eventCtx).actions;
  }
}

/**
 * Dispatches every action on mount. `useEffect` runs after the first paint and
 * before ink-testing-library's stdout captures the next frame — each dispatch
 * is synchronous on useReducer's internal state, and ink re-renders on the
 * next microtask once the batch drains. The harness awaits that microtask
 * before reading lastFrame() (see waitForRender).
 */
function ReplaySink({ actions }: { actions: StoreAction[] }): React.ReactElement {
  const { dispatch } = useStore();
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    for (const action of actions) dispatch(action);
  }, [actions, dispatch]);
  return React.createElement(Transcript);
}

/** Drains the microtask + timer queues enough for ink's re-render scheduler to
 *  commit the post-dispatch frame to stdout. 32 ms is one ink tick (default
 *  render interval is 16 ms with one grace tick). */
function waitForRender(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 48));
}

export async function replayEvents(events: ReplayEvent[]): Promise<HarnessInstance> {
  const actions: StoreAction[] = [];
  for (const evt of events) {
    for (const action of actionsForEvent(evt)) actions.push(action);
  }

  const instance = render(
    React.createElement(
      StoreProvider,
      { initialValues: { model: "test-model", capUsd: 10 } },
      React.createElement(ReplaySink, { actions })
    )
  );

  await waitForRender();

  return {
    lastFrame: () => instance.lastFrame() ?? "",
    unmount: () => instance.unmount(),
  };
}
