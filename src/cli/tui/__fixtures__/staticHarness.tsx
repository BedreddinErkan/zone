import { render } from "ink-testing-library";
import React from "react";
import { StoreProvider } from "../store.js";
import { Transcript } from "../components/Transcript.js";
import type { TranscriptEntry } from "../store.js";

export interface HarnessInstance {
  /** Checks ALL frames (static committed + dynamic) — use for transcript entry content */
  anyFrameContains: (text: string) => boolean;
  /** Last dynamic frame only — for live narrationBuffer and liveToolCall */
  lastFrame: () => string | undefined;
  unmount: () => void;
}

export function renderTranscript(transcript: TranscriptEntry[]): HarnessInstance {
  const instance = render(
    <StoreProvider initialValues={{ model: "test-model", capUsd: 10, resumedTranscript: transcript }}>
      <Transcript />
    </StoreProvider>
  );
  return {
    anyFrameContains: (text) => instance.frames.some((f) => f?.includes(text)),
    lastFrame: () => instance.lastFrame(),
    unmount: () => instance.unmount(),
  };
}
