import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// Mock store before importing the component
const mockDispatch = vi.fn();
const mockFeedbackData = { runId: "abc12345-0000-0000-0000-000000000000", logs: "line1\nline2\nline3", version: "0.0.1" };

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

const { FeedbackModal } = await import("./FeedbackModal.js");

function wait(ms = 80): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function renderModal() {
  const { stdin, lastFrame, unmount } = render(
    <FeedbackModal dispatch={mockDispatch} />
  );
  return { stdin, lastFrame, unmount };
}

describe("FeedbackModal", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
    mockCopyToClipboard.mockReset();
    mockOpenMailtoFeedback.mockReset();
    mockOpenUrlInBrowser.mockReset();
  });

  it("T-RENDER: shows title, runId, and log lines", () => {
    const { lastFrame, unmount } = renderModal();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Send feedback");
    expect(frame).toContain("abc12345");
    expect(frame).toContain("line1");
    unmount();
  });

  it("T-RENDER: shows footer instructions", () => {
    const { lastFrame, unmount } = renderModal();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Enter send");
    expect(frame).toContain("Esc cancel");
    unmount();
  });

  it("T-ESC: Esc dispatches FEEDBACK_MODAL_CLOSE, no clipboard/mailto call", async () => {
    const { stdin, unmount } = renderModal();
    stdin.write("\x1b");
    await wait();
    expect(mockDispatch).toHaveBeenCalledWith({ type: "FEEDBACK_MODAL_CLOSE" });
    expect(mockCopyToClipboard).not.toHaveBeenCalled();
    expect(mockOpenMailtoFeedback).not.toHaveBeenCalled();
    unmount();
  });

  it("T-ENTER: Enter copies to clipboard, opens GitHub issue, modal stays in delivered state", async () => {
    const { stdin, lastFrame, unmount } = renderModal();
    stdin.write("my bug report");
    await wait();
    stdin.write("\r");
    await wait();
    expect(mockCopyToClipboard).toHaveBeenCalledOnce();
    expect(mockOpenUrlInBrowser).toHaveBeenCalledOnce();
    // No close dispatched on the Enter success path — modal stays open
    const closeCall = mockDispatch.mock.calls.find(
      ([a]: [{ type: string }]) => a.type === "FEEDBACK_MODAL_CLOSE"
    );
    expect(closeCall).toBeUndefined();
    // No mailto on Enter
    expect(mockOpenMailtoFeedback).not.toHaveBeenCalled();
    // Modal is in "delivered" state
    expect(lastFrame()).toContain("Copied · GitHub opened · m for email · any key to close");
    unmount();
  });

  it("T-M-KEY: m key in delivered state opens mailto and closes modal with toast", async () => {
    const { stdin, unmount } = renderModal();
    stdin.write("\r");
    await wait();
    // Modal is now in delivered state; press m
    stdin.write("m");
    await wait();
    // openUrlInBrowser called twice: github (Enter) then mailto (m)
    expect(mockOpenUrlInBrowser).toHaveBeenCalledTimes(2);
    const closeCall = mockDispatch.mock.calls.find(
      ([a]: [{ type: string }]) => a.type === "FEEDBACK_MODAL_CLOSE"
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
    const { stdin, unmount } = renderModal();
    stdin.write("\r");
    await wait();
    expect(mockCopyToClipboard).toHaveBeenCalledOnce();
    const report = mockCopyToClipboard.mock.calls[0]?.[0] as string;
    expect(report).toContain("(no message)");
    unmount();
  });

  it("T-TYPING: character input updates message field", async () => {
    const { stdin, lastFrame, unmount } = renderModal();
    stdin.write("hello");
    await wait();
    expect(lastFrame()).toContain("hello");
    unmount();
  });

  it("T-REPORT: clipboard receives full report with runId and logs", async () => {
    const { stdin, unmount } = renderModal();
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
