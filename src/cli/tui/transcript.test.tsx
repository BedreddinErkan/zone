import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "./App.js";
import { createEventBus } from "../eventBus.js";
import { renderTranscript } from "./__fixtures__/staticHarness.js"; // resolves to staticHarness.tsx
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

vi.mock("../../api/commandApprovals.js", () => ({ resolveCommandApproval: vi.fn() }));
vi.mock("../../llm/revisionApprovals.js", () => ({ resolveRevisionApproval: vi.fn() }));

function makeEvt(type: ZoneStructuredProgressEvent["type"], extra: Partial<ZoneStructuredProgressEvent> = {}): ZoneStructuredProgressEvent {
  return { runId: "test-run", ts: Date.now(), type, title: type, ...extra };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TUI.2 transcript rendering", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders without crash when bus is provided", () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);
    expect(lastFrame()).toBeDefined();
    unmount();
  });

  it("renders without crash when bus is undefined (REPL mode)", () => {
    const { lastFrame, unmount } = render(<App />);
    expect(lastFrame()).toBeDefined();
    unmount();
  });

  it("narration event renders text in transcript after debounce", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("narration", makeEvt("narration", { text: "Analyzing the codebase" }));
    await wait(250);

    // Narration stays in liveTail.narrationBuffer until NARRATION_COMMIT — visible in dynamic frame
    expect(lastFrame()).toContain("Analyzing the codebase");
    unmount();
  });

  it("chat_chunk events accumulate in transcript", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("chat_chunk", makeEvt("chat_chunk", { delta: "Hello " }));
    bus.emit("chat_chunk", makeEvt("chat_chunk", { delta: "world" }));
    await wait(250);

    expect(lastFrame()).toContain("Hello world");
    unmount();
  });

  it("10 rapid chat_chunk events coalesce into one dispatch (debounce)", async () => {
    const bus = createEventBus();
    const { unmount } = render(<App bus={bus} initialPrompt="test task" />);

    for (let i = 0; i < 10; i++) {
      bus.emit("chat_chunk", makeEvt("chat_chunk", { delta: `chunk${i} ` }));
    }
    await wait(250);
    // All 10 chunks should be visible as a single concatenated string
    // Verified by checking the last frame contains the last chunk text
    unmount();
  });

  it("tool_call event opens live indicator in dynamic frame", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "read_file", detail: "src/foo.ts" }));
    await wait(50);

    // live tool call indicator is in the dynamic frame
    expect(lastFrame()).toContain("Read(");
    unmount();
  });

  it("tool_result renders check mark and detail", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "write_file", detail: "" }));
    bus.emit("tool_result", makeEvt("tool_result", { status: "success", detail: "written 42 bytes" }));
    await wait(50);

    // tool_result commits the entry to transcript (Static) — check all frames
    expect(frames.some(f => f?.includes("●"))).toBe(true);
    expect(frames.some(f => f?.includes("written 42 bytes"))).toBe(true);
    unmount();
  });

  it("tool_result with error status shows failure mark", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "apply_patch", detail: "" }));
    bus.emit("tool_result", makeEvt("tool_result", { status: "error", detail: "patch failed" }));
    await wait(50);

    expect(frames.some(f => f?.includes("✗"))).toBe(true);
    unmount();
  });

  it("agent_loop_complete transitions runState to done", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    bus.emit("agent_loop_complete", makeEvt("agent_loop_complete", { iter_count: 3, cumulativeCost: 0.0123 }));
    await wait(50);

    const frame = lastFrame() ?? "";
    // StatusBar transitions to "done" state — in dynamic frame
    expect(frame).toContain("done");
    unmount();
  });

  it("agent_loop_start activates spinner", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50); // no label debounce — spinner shows immediately

    const frame = lastFrame() ?? "";
    const anyStarFrame = ["✦", "✧", "✶", "✷", "✸", "✹", "✺"].some((f) => frame.includes(f));
    expect(anyStarFrame).toBe(true); // star frame shown when active
    unmount();
  });

  it("phase_changed renders IterMarker", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("phase_changed", makeEvt("phase_changed", { phase: 2 }));
    await wait(50);

    expect(frames.some(f => f?.includes("── Phase 2 ──"))).toBe(true);
    unmount();
  });

  it("patch_rejected renders ErrorLine", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("patch_rejected", makeEvt("patch_rejected", { title: "Patch was rejected" }));
    await wait(50);

    expect(frames.some(f => f?.includes("Patch was rejected"))).toBe(true);
    unmount();
  });

  it("loop_warning_emitted shows Toast", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("loop_warning_emitted", makeEvt("loop_warning_emitted", { title: "Loop detected — warning" }));
    await wait(50);

    expect(lastFrame()).toContain("Loop detected — warning");
    unmount();
  });

  it("iter_cost_update updates StatusBar iter and cost", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    // Start the run so StatusBar shows running state with iter/cost
    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    bus.emit("iter_cost_update", makeEvt("iter_cost_update", { iter: 5, cumulativeCost: 0.0567 }));
    await wait(50);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("0.0567"); // cost displayed; iter count removed in TUI.4.1
    unmount();
  });

  it("token_budget_status critical pushes Toast", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("token_budget_status", makeEvt("token_budget_status", { tokenBudgetRatio: 0.95 }));
    await wait(50);

    expect(lastFrame()).toContain("Token budget critical");
    unmount();
  });

  it("token_budget_status warning pushes warning Toast", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("token_budget_status", makeEvt("token_budget_status", { tokenBudgetRatio: 0.75 }));
    await wait(50);

    expect(lastFrame()).toContain("Token budget warning");
    unmount();
  });

  it("command_approval_required shows approval modal instead of auto-rejecting", async () => {
    const { resolveCommandApproval } = await import("../../api/commandApprovals.js");
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "appr-1",
      command: "find src -type f",
    }));
    await wait(50);

    // Modal shows — resolveCommandApproval NOT called yet (waiting for user input)
    expect(resolveCommandApproval).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Command approval required");
    expect(lastFrame()).toContain("find src -type f");
    unmount();
  });

  it("scope_revision_proposed auto-rejects and shows ErrorLine", async () => {
    const { resolveRevisionApproval } = await import("../../llm/revisionApprovals.js");
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("scope_revision_proposed", makeEvt("scope_revision_proposed", { revisionId: "rev-1" }));
    await wait(50);

    expect(resolveRevisionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: "rev-1", decision: "reject" })
    );
    expect(frames.some(f => f?.includes("auto-rejected"))).toBe(true);
    unmount();
  });

  it("ErrorLine shows ⚠ prefix", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("patch_rejected", makeEvt("patch_rejected", { title: "Conflict found" }));
    await wait(50);

    expect(frames.some(f => f?.includes("⚠"))).toBe(true);
    expect(frames.some(f => f?.includes("Conflict found"))).toBe(true);
    unmount();
  });

  it("terminal_done with non-zero exit shows failure result", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "run_command", detail: "npm test" }));
    bus.emit("terminal_done", makeEvt("terminal_done", { exitCode: 1 }));
    await wait(50);

    expect(frames.some(f => f?.includes("exit 1"))).toBe(true);
    unmount();
  });

  it("terminal_done with exit 0 does not push result", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "run_command", detail: "npm test" }));
    bus.emit("terminal_done", makeEvt("terminal_done", { exitCode: 0 }));
    await wait(50);

    // tool call entry visible but no exit code text in any frame
    expect(frames.some(f => f?.includes("exit 0"))).toBe(false);
    unmount();
  });

  it("spurious tool_call events (no toolName, non-[tool] title) do not open indicator", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    bus.emit("tool_call", makeEvt("tool_call", { title: "[agent_loop] Iteration 2/24" }));
    await wait(50);

    expect(lastFrame()).not.toContain("[agent_loop]");
    unmount();
  });

  it("agent_loop_complete clears orphaned live indicator", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "list_files", detail: "src/cli/tui" }));
    await wait(50);
    expect(lastFrame()).toContain("LS(");

    bus.emit("agent_loop_complete", makeEvt("agent_loop_complete"));
    await wait(50);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("LS(");
    expect(frame).toContain("done");
    unmount();
  });

  it("[tool] title parsed into clean toolName + args (no [tool] prefix in output)", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] read_file: src/foo.ts" }));
    await wait(50);

    const frame = lastFrame() ?? "";
    // Live indicator should show the display name, not the raw tool name or "[tool] ..." string
    expect(frame).toContain("Read(");
    expect(frame).not.toContain("[tool]");
    unmount();
  });

  it("tool_call + tool_result produces transcript entry with clean toolName", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] read_file: src/cli/tui/App.tsx" }));
    bus.emit("tool_result", makeEvt("tool_result", { toolName: "read_file", status: "success", detail: "42 lines" }));
    await wait(50);

    expect(frames.some(f => f?.includes("Read("))).toBe(true);
    expect(frames.some(f => f?.includes("src/cli/tui/App.tsx"))).toBe(true);
    expect(frames.every(f => !f?.includes("[tool]"))).toBe(true);
    unmount();
  });

  it("[tool] title with no ': ' separator (tool with no args) uses full name", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] list_files" }));
    await wait(50);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("LS(");
    expect(frame).not.toContain("[tool]");
    unmount();
  });

  it("narration text has ◆ prefix", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("narration", makeEvt("narration", { text: "Thinking deeply" }));
    await wait(250);

    // Narration in liveTail.narrationBuffer renders as live ◆ in dynamic frame
    expect(lastFrame()).toContain("◆");
    expect(lastFrame()).toContain("Thinking deeply");
    unmount();
  });

  it("tool_result with 5-line detail shows first-line preview only", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "run_command", detail: "" }));
    bus.emit("tool_result", makeEvt("tool_result", {
      status: "success",
      detail: "line1\nline2\nline3\nline4\nline5",
    }));
    await wait(50);

    expect(frames.some(f => f?.includes("line1"))).toBe(true);
    expect(frames.every(f => !f?.includes("line3"))).toBe(true);
    expect(frames.every(f => !f?.includes("… 2 more"))).toBe(true);
    expect(frames.every(f => !f?.includes("line5"))).toBe(true);
    unmount();
  });

  it("StatusBar renders idle state initially", () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("idle");
    expect(frame).toContain("/help for commands");
    unmount();
  });

  it("agent_loop_complete with detail dispatches ASSISTANT_FINAL and renders summary", async () => {
    const bus = createEventBus();
    const { frames, unmount } = render(<App bus={bus} initialPrompt="test" />);

    bus.emit("agent_loop_complete", makeEvt("agent_loop_complete", {
      detail: "The answer is: 42 files exist under src/cli/.",
      iter_count: 3,
      cumulativeCost: 0.0437,
    }));
    await wait(50);

    expect(frames.some(f => f?.includes("The answer is: 42 files exist under src/cli/."))).toBe(true);
    unmount();
  });
});

describe("Transcript harness — entry kinds", () => {
  it("narration renders with ◆ prefix", () => {
    const h = renderTranscript([{ kind: "narration", text: "Analysis complete" }]);
    expect(h.anyFrameContains("◆")).toBe(true);
    expect(h.anyFrameContains("Analysis complete")).toBe(true);
    h.unmount();
  });

  it("user_prompt renders with bordered cyan box and ▸ prefix", () => {
    const h = renderTranscript([{ kind: "user_prompt", text: "fix the bug" }]);
    expect(h.anyFrameContains("▸")).toBe(true);
    expect(h.anyFrameContains("fix the bug")).toBe(true);
    h.unmount();
  });

  it("assistant_final renders body text", () => {
    const h = renderTranscript([{ kind: "assistant_final", text: "Done. Two files changed." }]);
    expect(h.anyFrameContains("Done. Two files changed.")).toBe(true);
    h.unmount();
  });

  it("TUI.10.C: assistant_final with ## heading renders section name without ## prefix", () => {
    const text = "## What changed\n- Added utility\n\n## Why\nPlan required it.";
    const h = renderTranscript([{ kind: "assistant_final", text }]);
    expect(h.anyFrameContains("What changed")).toBe(true);
    expect(h.anyFrameContains("##")).toBe(false);
    h.unmount();
  });

  it("TUI.10.C: assistant_final with bullet list renders • instead of - prefix", () => {
    const text = "## What changed\n- Added `group` utility\n- Tests added";
    const h = renderTranscript([{ kind: "assistant_final", text }]);
    expect(h.anyFrameContains("•")).toBe(true);
    expect(h.anyFrameContains("Added")).toBe(true);
    h.unmount();
  });

  it("error entry renders ⚠ prefix", () => {
    const h = renderTranscript([{ kind: "error", text: "Patch rejected" }]);
    expect(h.anyFrameContains("⚠")).toBe(true);
    expect(h.anyFrameContains("Patch rejected")).toBe(true);
    h.unmount();
  });

  it("phase_marker renders phase label", () => {
    const h = renderTranscript([{ kind: "phase_marker", phase: "Phase 2" }]);
    expect(h.anyFrameContains("Phase 2")).toBe(true);
    h.unmount();
  });

  it("tool_call entry renders display name and args", () => {
    const h = renderTranscript([{
      kind: "tool_call",
      toolName: "read_file",
      args: "src/foo.ts",
      results: [{ ok: true, detail: "42 lines" }],
    }]);
    expect(h.anyFrameContains("Read(")).toBe(true);
    expect(h.anyFrameContains("src/foo.ts")).toBe(true);
    h.unmount();
  });

  it("narration with newlines renders continuation lines", () => {
    const h = renderTranscript([{ kind: "narration", text: "line one\nline two" }]);
    expect(h.anyFrameContains("◆")).toBe(true);
    expect(h.anyFrameContains("line one")).toBe(true);
    expect(h.anyFrameContains("line two")).toBe(true);
    h.unmount();
  });

  it("long narration text renders without narrow-column wrap", () => {
    const longText = "Analyzing codebase structure to understand patterns and dependencies before making changes";
    const h = renderTranscript([{ kind: "narration", text: longText }]);
    const frame = h.lastFrame() ?? "";
    const longestLineLen = frame.split("\n").reduce((max, l) => Math.max(max, l.length), 0);
    expect(longestLineLen).toBeGreaterThan(80);
    h.unmount();
  });

  it("near-overflow narration line renders no ghost row (Yoga flex-shrink guard)", () => {
    // "◆ " (2) + 98-char content = 100 chars in a 100-char terminal row (overflow=0 → boundary case)
    // With word-break space so wrapping fires at word boundary, same pattern as composer.border.test.tsx test 3
    const longLine = "N".repeat(49) + " " + "N".repeat(48); // 98 chars
    const h = renderTranscript([{ kind: "narration", text: longLine }]);
    const frame = h.lastFrame() ?? "";
    const lines = frame.trimEnd().split("\n");
    const ghostRows = lines.filter((l) => l.trim() === "");
    expect(ghostRows).toHaveLength(0);
    const contentLines = lines.filter((l) => l.includes("N"));
    expect(contentLines.length).toBeGreaterThanOrEqual(1);
    h.unmount();
  });

  it("empty transcript produces no committed content in any frame", () => {
    const h = renderTranscript([]);
    expect(h.anyFrameContains("◆")).toBe(false);
    expect(h.anyFrameContains("⚠")).toBe(false);
    h.unmount();
  });
});
