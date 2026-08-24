import { render } from "ink-testing-library";
import { render as inkRender } from "ink";
import { EventEmitter } from "node:events";
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

/** Renders at a specific column width. Uses Ink's render directly (ink-testing-library hardcodes columns=100). */
export function renderTranscriptAt(
  transcript: TranscriptEntry[],
  columns: number,
  seedStreamingAnswer?: string
): HarnessInstance {
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: 40,
    write: (frame: string) => { frames.push(frame); return true; },
  });
  const instance = inkRender(
    <StoreProvider initialValues={{ model: "test-model", capUsd: 10, resumedTranscript: transcript, seedStreamingAnswer }}>
      <Transcript />
    </StoreProvider>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { stdout: stdout as any, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  return {
    anyFrameContains: (text) => frames.some((f) => f?.includes(text)),
    lastFrame: () => frames[frames.length - 1],
    unmount: () => instance.unmount(),
  };
}
