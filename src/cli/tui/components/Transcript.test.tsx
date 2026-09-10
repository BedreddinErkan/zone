import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { StoreProvider } from "../store.js";
import { Transcript } from "./Transcript.js";
import type { TranscriptEntry } from "../store.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Transcript — compact_summary rendering", () => {
  it("renders a compact_summary entry as a dim line with counts", async () => {
    const entry: TranscriptEntry = {
      kind: "compact_summary",
      totalCompacted: 400,
      counts: { toolCalls: 12, narrations: 250, errors: 3, subagents: 0 },
    };
    const instance = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10, resumedTranscript: [entry] }}>
        <Transcript />
      </StoreProvider>
    );
    await new Promise(r => setTimeout(r, 50));
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("400 earlier events compacted");
    expect(frame).toContain("12 tool calls");
    expect(frame).toContain("250 narrations");
    expect(frame).toContain("3 errors");
    instance.unmount();
  });

  it("omits zero-count categories", async () => {
    const entry: TranscriptEntry = {
      kind: "compact_summary",
      totalCompacted: 50,
      counts: { toolCalls: 5, narrations: 0, errors: 0, subagents: 0 },
    };
    const instance = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10, resumedTranscript: [entry] }}>
        <Transcript />
      </StoreProvider>
    );
    await new Promise(r => setTimeout(r, 50));
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("5 tool calls");
    expect(frame).not.toContain("narration");
    expect(frame).not.toContain("error");
    instance.unmount();
  });
});
