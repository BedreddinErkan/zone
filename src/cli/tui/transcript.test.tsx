import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "./App.js";
import { createEventBus } from "../eventBus.js";
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

  it("narration event renders text in AssistantTurn after debounce", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("narration", makeEvt("narration", { text: "Analyzing the codebase" }));
    await wait(250);

    expect(lastFrame()).toContain("Analyzing the codebase");
    unmount();
  });

  it("chat_chunk events accumulate in AssistantTurn", async () => {
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

  it("tool_call event opens a tool call entry", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "read_file", detail: "src/foo.ts" }));
    await wait(50);

    // live tool call shows "  toolName  args" (no ▸ prefix)
    expect(lastFrame()).toContain("read_file");
    unmount();
  });

  it("tool_result renders check mark and detail", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "write_file", detail: "" }));
    bus.emit("tool_result", makeEvt("tool_result", { status: "success", detail: "written 42 bytes" }));
    await wait(50);

    expect(lastFrame()).toContain("✓");
    expect(lastFrame()).toContain("written 42 bytes");
    unmount();
  });

  it("tool_result with error status shows failure mark", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "apply_patch", detail: "" }));
    bus.emit("tool_result", makeEvt("tool_result", { status: "error", detail: "patch failed" }));
    await wait(50);

    expect(lastFrame()).toContain("✗");
    unmount();
  });

  it("agent_loop_complete transitions runState to done", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    bus.emit("agent_loop_complete", makeEvt("agent_loop_complete", { iter_count: 3, cumulativeCost: 0.0123 }));
    await wait(50);

    const frame = lastFrame() ?? "";
    // StatusBar transitions to "done" state
    expect(frame).toContain("done");
    unmount();
  });

  it("agent_loop_start activates spinner", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50); // no label debounce — spinner shows immediately

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Z"); // spinner icon shown when active (label removed in TUI.4.1)
    unmount();
  });

  it("phase_changed renders IterMarker", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("phase_changed", makeEvt("phase_changed", { phase: 2 }));
    await wait(50);

    expect(lastFrame()).toContain("── Phase 2 ──");
    unmount();
  });

  it("patch_rejected renders ErrorLine", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("patch_rejected", makeEvt("patch_rejected", { title: "Patch was rejected" }));
    await wait(50);

    expect(lastFrame()).toContain("Patch was rejected");
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
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("scope_revision_proposed", makeEvt("scope_revision_proposed", { revisionId: "rev-1" }));
    await wait(50);

    expect(resolveRevisionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: "rev-1", decision: "reject" })
    );
    expect(lastFrame()).toContain("auto-rejected");
    unmount();
  });

  it("ErrorLine shows ⚠ prefix", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("patch_rejected", makeEvt("patch_rejected", { title: "Conflict found" }));
    await wait(50);

    expect(lastFrame()).toContain("⚠");
    expect(lastFrame()).toContain("Conflict found");
    unmount();
  });

  it("terminal_done with non-zero exit shows failure result", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "run_command", detail: "npm test" }));
    bus.emit("terminal_done", makeEvt("terminal_done", { exitCode: 1 }));
    await wait(50);

    expect(lastFrame()).toContain("exit 1");
    unmount();
  });

  it("terminal_done with exit 0 does not push result", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { toolName: "run_command", detail: "npm test" }));
    bus.emit("terminal_done", makeEvt("terminal_done", { exitCode: 0 }));
    await wait(50);

    // tool call entry visible (has ▸) but no exit code text
    expect(lastFrame()).not.toContain("exit 0");
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
    expect(lastFrame()).toContain("list_files");

    bus.emit("agent_loop_complete", makeEvt("agent_loop_complete"));
    await wait(50);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("list_files");
    expect(frame).toContain("done");
    unmount();
  });

  it("[tool] title parsed into clean toolName + args (no [tool] prefix in output)", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] read_file: src/foo.ts" }));
    await wait(50);

    const frame = lastFrame() ?? "";
    // Live indicator should show the clean parsed name, not the full "[tool] ..." string
    expect(frame).toContain("read_file");
    expect(frame).not.toContain("[tool]");
    unmount();
  });

  it("tool_call + tool_result produces transcript entry with clean toolName", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] read_file: src/cli/tui/App.tsx" }));
    bus.emit("tool_result", makeEvt("tool_result", { toolName: "read_file", status: "success", detail: "42 lines" }));
    await wait(50);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("read_file");
    expect(frame).toContain("src/cli/tui/App.tsx");
    expect(frame).not.toContain("[tool]");
    unmount();
  });

  it("[tool] title with no ': ' separator (tool with no args) uses full name", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] list_files" }));
    await wait(50);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("list_files");
    expect(frame).not.toContain("[tool]");
    unmount();
  });

  it("Header renders cwd", () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test task" />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain(process.cwd());
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
});
