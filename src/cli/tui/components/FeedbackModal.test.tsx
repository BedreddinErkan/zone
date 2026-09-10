import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// Mock store before importing the component
const mockDispatch = vi.fn();
const mockFeedbackData = { runId: "abc12345-0000-0000-0000-000000000000", logs: "line1\nline2\nline3", version: "0.0.1", sessionId: "s1", repoPath: "/repo" };

vi.mock("../store.js", () => ({
  useStore: () => ({
    state: {
      feedbackData: mockFeedbackData,
    },
    dispatch: mockDispatch,
  }),
}));

// Mock clipboard/mailto helpers
const mockCopyToClipboard = vi.fn();
const mockOpenMailtoFeedback = vi.fn();
const mockOpenUrlInBrowser = vi.fn();

vi.mock("../../../utils/clipboardMailto.js", () => ({
  copyToClipboard: mockCopyToClipboard,
  openMailtoFeedback: mockOpenMailtoFeedback,
  openUrlInBrowser: mockOpenUrlInBrowser,
}));

const { FeedbackForm } = await import("./FeedbackForm.js");

function wait(ms = 80): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function renderForm() {
  const { stdin, lastFrame, unmount } = render(<FeedbackForm />);
  return { stdin, lastFrame, unmount };
}

describe("FeedbackForm", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
    mockCopyToClipboard.mockReset();
    mockOpenMailtoFeedback.mockReset();
    mockOpenUrlInBrowser.mockReset();
  });

  it("T-RENDER: shows runId and log lines", () => {
    const { lastFrame, unmount } = renderForm();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("abc12345");
    expect(frame).toContain("line1");
    unmount();
  });

  it("T-ESC: Esc does not dispatch from component (central handler owns Esc, Phase 3b)", async () => {
    const { stdin, unmount } = renderForm();
    stdin.write("\x1b");
    await wait();
    // Component no longer dispatches OVERLAY_POP on Esc — the central handler in App.tsx does.
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
    expect(mockOpenMailtoFeedback).not.toHaveBeenCalled();
    unmount();
  });

  it("T-ENTER: Enter copies to clipboard, opens GitHub issue, form stays in delivered state", async () => {
    const { stdin, lastFrame, unmount } = renderForm();
    stdin.write("my bug report");
    await wait();
    stdin.write("\r");
    await wait();
    expect(mockCopyToClipboard).toHaveBeenCalledOnce();
    expect(mockOpenUrlInBrowser).toHaveBeenCalledOnce();
    // No OVERLAY_POP on the Enter success path — form stays open
    const closeCall = mockDispatch.mock.calls.find(
      ([a]: [{ type: string }]) => a.type === "OVERLAY_POP"
    );
    expect(closeCall).toBeUndefined();
    // No mailto on Enter
    expect(mockOpenMailtoFeedback).not.toHaveBeenCalled();
    // Form is in "delivered" state
    expect(lastFrame()).toContain("Copied · GitHub opened · m for email · any key to close");
    unmount();
  });

  it("T-M-KEY: m key in delivered state opens mailto and closes with OVERLAY_POP + toast", async () => {
    const { stdin, unmount } = renderForm();
    stdin.write("\r");
    await wait();
    // Form is now in delivered state; press m
    stdin.write("m");
    await wait();
    // openUrlInBrowser called twice: github (Enter) then mailto (m)
    expect(mockOpenUrlInBrowser).toHaveBeenCalledTimes(2);
    const closeCall = mockDispatch.mock.calls.find(
      ([a]: [{ type: string }]) => a.type === "OVERLAY_POP"
    );
    expect(closeCall).toBeDefined();
    const toastCall = mockDispatch.mock.calls.find(
      ([a]: [{ type: string }]) => a.type === "TOAST_PUSH"
    );
    expect(toastCall).toBeDefined();
    expect((toastCall?.[0] as { entry: { message: string } }).entry.message).toBe("Email draft opened");
    unmount();
  });

  it("T-ENTER-EMPTY: Enter with no message still delivers (uses placeholder)", async () => {
    const { stdin, unmount } = renderForm();
    stdin.write("\r");
    await wait();
    expect(mockCopyToClipboard).toHaveBeenCalledOnce();
    const report = mockCopyToClipboard.mock.calls[0]?.[0] as string;
    expect(report).toContain("(no message)");
    unmount();
  });

  it("T-TYPING: character input updates message field", async () => {
    const { stdin, lastFrame, unmount } = renderForm();
    stdin.write("hello");
    await wait();
    expect(lastFrame()).toContain("hello");
    unmount();
  });

  it("T-REPORT: clipboard receives full report with runId and logs", async () => {
    const { stdin, unmount } = renderForm();
    stdin.write("test issue");
    await wait();
    stdin.write("\r");
    await wait();
    const report = mockCopyToClipboard.mock.calls[0]?.[0] as string;
    expect(report).toContain("test issue");
    expect(report).toContain("Run ID:");
    expect(report).toContain("abc12345");
    expect(report).toContain("## Diagnostics");
    unmount();
  });
});
