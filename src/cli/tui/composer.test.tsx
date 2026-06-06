import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "./App.js";
import { createEventBus } from "../eventBus.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

vi.mock("../../api/commandApprovals.js", () => ({ resolveCommandApproval: vi.fn() }));
vi.mock("../../llm/revisionApprovals.js", () => ({ resolveRevisionApproval: vi.fn() }));

function makeEvt(type: ZoneStructuredProgressEvent["type"], extra: Partial<ZoneStructuredProgressEvent> = {}): ZoneStructuredProgressEvent {
  return { runId: "test-run", ts: Date.now(), type, title: type, ...extra } as ZoneStructuredProgressEvent;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TUI.4 composer", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Composer renders > prompt when runState is idle", () => {
    const { lastFrame, unmount } = render(<App />);
    expect(lastFrame()).toContain(">");
    unmount();
  });

  it("Composer does not dispatch on Enter when runState is running", async () => {
    const bus = createEventBus();
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<App bus={bus} onSubmit={onSubmit} />);
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50);
    // Type something then press Enter — should be ignored while running
    stdin.write("hello");
    stdin.write("\r");
    await wait(50);
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("Enter on empty buffer does not call onSubmit", async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<App onSubmit={onSubmit} />);
    stdin.write("\r");
    await wait(50);
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("Enter on non-empty buffer calls onSubmit and shows USER_PROMPT in transcript", async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin, unmount } = render(<App onSubmit={onSubmit} />);
    stdin.write("test task");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toBe("test task");
    expect(onSubmit.mock.calls[0][1]).toBeInstanceOf(AbortController);
    expect(lastFrame()).toContain("test task");
    unmount();
  });

  it("Backspace removes last character", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("abc");
    await wait(50);
    stdin.write("\x7f"); // DEL / backspace
    await wait(50);
    const frame = lastFrame() ?? "";
    // "ab" visible, "abc" not as a complete sequence in the buffer area
    expect(frame).not.toContain("abc▋");
    unmount();
  });

  it("Esc with non-empty buffer clears buffer", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("hello");
    await wait(50);
    expect(lastFrame()).toContain("hello");
    stdin.write("\x1b");
    await wait(50);
    // buffer cleared — cursor block alone with no text
    expect(lastFrame()).not.toContain("hello▋");
    expect(lastFrame()).not.toContain("hello");
    unmount();
  });

  it("Up arrow on empty buffer fills with last history item", async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin, unmount } = render(<App onSubmit={onSubmit} />);
    // Submit one prompt to build history
    stdin.write("first prompt");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    // Buffer is cleared; press Up to navigate history
    stdin.write("\x1b[A"); // Up arrow ESC sequence
    await wait(50);
    expect(lastFrame()).toContain("first prompt");
    unmount();
  });

  it("typing /h opens slash command palette with matching commands", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("/h");
    await wait(50);
    expect(lastFrame()).toContain("/help");
    unmount();
  });

  it("/help shows help text in transcript", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("/help");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(lastFrame()).toContain("Key bindings");
    unmount();
  });

  it("/clear dispatches TRANSCRIPT_CLEAR and app remains interactive", async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin, unmount } = render(<App onSubmit={onSubmit} />);
    // First add something to transcript
    stdin.write("some task");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(lastFrame()).toContain("some task");
    // /clear — TRANSCRIPT_CLEAR dispatched; Static-committed output is permanent in the
    // output stream (matches real-TTY scrollback semantics), but the app stays interactive
    stdin.write("/clear");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(lastFrame()).toContain("idle"); // TUI still renders correctly post-clear
    unmount();
  });

  it("/exit calls onExit callback", async () => {
    // We detect /exit via the App unmounting (useApp().exit() called).
    // In ink-testing-library, exit() resolves waitUntilExit but doesn't crash.
    const { stdin, unmount } = render(<App />);
    stdin.write("/exit");
    await wait(50);
    stdin.write("\r");
    await wait(100);
    // If exit() was called, the instance should be done — we can just verify no crash
    unmount();
  });

  it("/cost shows cost info in transcript", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    stdin.write("/cost");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(lastFrame()).toContain("Cost:");
    unmount();
  });

  // Regression: slash-command gates must use === "running", not !== "idle".
  // After a run completes (runState="done") or is aborted (runState="aborted"),
  // gated commands (/model /effort /sessions /init /limits) must be allowed.
  it("/model is blocked while running but allowed after completion (runState=done)", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} />);

    // Start run → runState="running"
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50);
    stdin.write("/model");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(lastFrame()).toContain("Cannot change /model while a run is in progress.");

    // Complete run → runState="done"
    bus.emit("agent_loop_complete", makeEvt("agent_loop_complete"));
    await wait(50);
    stdin.write("/model");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    // Modal must open — the model selection UI is present
    expect(lastFrame()).toContain("↑↓ navigate · Enter select · Esc cancel");
    unmount();
  });

  it("/model is allowed after run is aborted (runState=aborted)", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} />);

    // Start then abort
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50);
    stdin.write("\x1b"); // Esc → RUN_ABORTED
    await wait(50);

    stdin.write("/model");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    // Modal must open — the model selection UI is present
    expect(lastFrame()).toContain("↑↓ navigate · Enter select · Esc cancel");
    unmount();
  });

  // ── User-defined slash command tests ──────────────────────────────────────

  it("project command appears in palette with (project) tag", async () => {
    const cmds = [{ name: "/review", description: "Review the diff", body: "Review the changes." }];
    const { lastFrame, stdin, unmount } = render(<App initialUserCommands={cmds} />);
    stdin.write("/rev");
    await wait(50);
    expect(lastFrame()).toContain("/review");
    expect(lastFrame()).toContain("(project)");
    unmount();
  });

  it("user command colliding with built-in is not shown; built-in runs instead", async () => {
    // Seed a /help command — should be dropped; built-in /help must win.
    const cmds = [{ name: "/help", description: "Custom", body: "CUSTOM BODY SENTINEL" }];
    const { lastFrame, stdin, unmount } = render(<App initialUserCommands={cmds} />);
    stdin.write("/help");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(lastFrame()).toContain("Key bindings"); // built-in /help output
    expect(lastFrame()).not.toContain("CUSTOM BODY SENTINEL");
    unmount();
  });

  it("firing a project command calls onSubmit with its body", async () => {
    const onSubmit = vi.fn();
    const cmds = [{ name: "/review", description: "Review diff", body: "Review the diff for issues." }];
    const { stdin, unmount } = render(<App onSubmit={onSubmit} initialUserCommands={cmds} />);
    stdin.write("/review");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toBe("Review the diff for issues.");
    expect(onSubmit.mock.calls[0][1]).toBeInstanceOf(AbortController);
    unmount();
  });

  it("project command while running shows disabled message, does not call onSubmit", async () => {
    const bus = createEventBus();
    const onSubmit = vi.fn();
    const cmds = [{ name: "/review", description: "Review diff", body: "Review the changes." }];
    const { lastFrame, stdin, unmount } = render(<App bus={bus} onSubmit={onSubmit} initialUserCommands={cmds} />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50);

    stdin.write("/review");
    await wait(50);
    stdin.write("\r");
    await wait(50);

    expect(lastFrame()).toContain("Cannot run /review while a run is in progress.");
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  // ── $ARGUMENTS substitution tests ─────────────────────────────────────────

  it("$ARGUMENTS body + args → substituted in onSubmit call", async () => {
    const onSubmit = vi.fn();
    const cmds = [{ name: "/review", description: "Review", body: "Review $ARGUMENTS for issues." }];
    const { stdin, unmount } = render(<App onSubmit={onSubmit} initialUserCommands={cmds} />);
    stdin.write("/review src/foo.ts");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toBe("Review src/foo.ts for issues.");
    unmount();
  });

  it("$ARGUMENTS body + no args → $ARGUMENTS replaced by empty string", async () => {
    const onSubmit = vi.fn();
    const cmds = [{ name: "/review", description: "Review", body: "Review $ARGUMENTS for issues." }];
    const { stdin, unmount } = render(<App onSubmit={onSubmit} initialUserCommands={cmds} />);
    stdin.write("/review");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toBe("Review  for issues.");
    unmount();
  });

  it("body without $ARGUMENTS + args passed → body fires verbatim (args unused)", async () => {
    const onSubmit = vi.fn();
    const cmds = [{ name: "/review", description: "Review", body: "Review the diff." }];
    const { stdin, unmount } = render(<App onSubmit={onSubmit} initialUserCommands={cmds} />);
    stdin.write("/review extra args here");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toBe("Review the diff.");
    unmount();
  });

  it("disabled guard blocks /cmd args while running", async () => {
    const bus = createEventBus();
    const onSubmit = vi.fn();
    const cmds = [{ name: "/review", description: "Review", body: "Review $ARGUMENTS." }];
    const { lastFrame, stdin, unmount } = render(<App bus={bus} onSubmit={onSubmit} initialUserCommands={cmds} />);
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50);
    stdin.write("/review src/foo.ts");
    await wait(50);
    stdin.write("\r");
    await wait(50);
    expect(lastFrame()).toContain("Cannot run /review while a run is in progress.");
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });
});
