import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "./App.js";
import { createEventBus } from "../eventBus.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

vi.mock("../../api/commandApprovals.js", () => ({
  resolveCommandApproval: vi.fn().mockReturnValue({ ok: true }),
}));
vi.mock("../../llm/revisionApprovals.js", () => ({ resolveRevisionApproval: vi.fn() }));
vi.mock("../../llm/planApprovals.js", () => ({ resolvePlanApproval: vi.fn().mockReturnValue({ ok: true }) }));

function makeEvt(type: ZoneStructuredProgressEvent["type"], extra: Partial<ZoneStructuredProgressEvent> = {}): ZoneStructuredProgressEvent {
  return { runId: "test-run", ts: Date.now(), type, title: type, ...extra } as ZoneStructuredProgressEvent;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TUI.4.4 approval modal", () => {
  let resolveCommandApproval: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ resolveCommandApproval } = await import("../../api/commandApprovals.js") as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // T.1: modal renders when command_approval_required fires
  it("T.1: shows modal with command text on command_approval_required", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} initialPrompt="test" />);

    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "appr-1",
      command: "find src -type f | sort",
    }));
    await wait(50);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Command approval required");
    expect(frame).toContain("find src -type f | sort");
    expect(frame).toContain("[Y]");
    expect(frame).toContain("[N]");
    expect(frame).toContain("[T]");
    unmount();
  });

  // T.2: Y approves and closes modal
  it("T.2: Y keypress approves the command and closes modal", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} initialPrompt="test" />);

    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "appr-2",
      command: "npm test",
    }));
    await wait(50);
    expect(lastFrame()).toContain("Command approval required");

    stdin.write("y");
    await wait(50);

    expect(resolveCommandApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "appr-2", approved: true })
    );
    // Modal gone
    expect(lastFrame()).not.toContain("Command approval required");
    unmount();
  });

  // T.3: N rejects, commits ⚠ blocked to transcript, closes modal
  it("T.3: N keypress rejects, commits blocked entry, closes modal", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} initialPrompt="test" />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] run_command: find src -type f | sort" }));
    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "appr-3",
      command: "find src -type f | sort",
    }));
    await wait(50);
    expect(lastFrame()).toContain("Command approval required");

    stdin.write("n");
    await wait(50);

    expect(resolveCommandApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "appr-3", approved: false })
    );
    expect(lastFrame()).not.toContain("Command approval required");
    // Blocked indicator should appear in transcript
    expect(lastFrame()).toContain("blocked");
    unmount();
  });

  // T.4: Esc rejects (same as N)
  it("T.4: Esc keypress rejects like N", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} initialPrompt="test" />);

    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] run_command: ls" }));
    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "appr-4",
      command: "ls",
    }));
    await wait(50);

    stdin.write("\x1b"); // Esc
    await wait(50);

    expect(resolveCommandApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "appr-4", approved: false })
    );
    expect(lastFrame()).not.toContain("Command approval required");
    unmount();
  });

  // T.5: T trusts prefix, approves this invocation, subsequent command auto-approves
  it("T.5: T keypress trusts prefix; second matching command auto-approves without modal", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} initialPrompt="test" />);

    // First approval: press T
    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "appr-5a",
      command: "find src -name '*.ts'",
    }));
    await wait(50);
    expect(lastFrame()).toContain("Command approval required");

    stdin.write("t");
    await wait(50);

    // First command approved
    expect(resolveCommandApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "appr-5a", approved: true })
    );
    expect(lastFrame()).not.toContain("Command approval required");

    // Second command with same "find" prefix → auto-approved, no modal
    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "appr-5b",
      command: "find src -type d",
    }));
    await wait(50);

    // Modal never shown for second command
    expect(lastFrame()).not.toContain("Command approval required");
    expect(resolveCommandApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "appr-5b", approved: true })
    );
    unmount();
  });

  // T.6: Composer input blocked when modal is shown
  it("T.6: Composer ignores keypresses while approval modal is active", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} />);

    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "appr-6",
      command: "rm -rf /",
    }));
    await wait(50);
    expect(lastFrame()).toContain("Command approval required");

    // Type something — should not appear in composer buffer
    stdin.write("hello");
    await wait(50);

    // Composer is blocked; input doesn't accumulate in the prompt area
    expect(lastFrame()).not.toContain("hello");
    unmount();
  });

  // T.8: repeated Y on the same command creates two visible entries
  it("T.8: Y on second approval of same command creates new visible entry", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} initialPrompt="test" />);

    // First approval
    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] run_command: find src" }));
    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "a1",
      command: "find src",
    }));
    await wait(50);
    stdin.write("y");
    await wait(50);
    bus.emit("tool_result", makeEvt("tool_result", { toolName: "run_command", status: "success", detail: "src/foo.ts" }));
    await wait(50);
    expect(lastFrame()).toContain("src/foo.ts");

    // Second approval — same command
    bus.emit("tool_call", makeEvt("tool_call", { title: "[tool] run_command: find src" }));
    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "a2",
      command: "find src",
    }));
    await wait(50);
    stdin.write("y");
    await wait(50);
    bus.emit("tool_result", makeEvt("tool_result", { toolName: "run_command", status: "success", detail: "src/bar.ts" }));
    await wait(50);

    // Both results visible (two separate entries)
    expect(lastFrame()).toContain("src/foo.ts");
    expect(lastFrame()).toContain("src/bar.ts");
    unmount();
  });

  // T.7: Esc does NOT abort the run when modal is active
  it("T.7: Esc does not abort running task when modal is active", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} initialPrompt="test" />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    await wait(50);
    // Running state shows "esc abort" hint in StatusBar
    expect(lastFrame()).toContain("esc abort");

    bus.emit("command_approval_required", makeEvt("command_approval_required", {
      approvalId: "appr-7",
      command: "ls",
    }));
    await wait(50);

    stdin.write("\x1b");
    await wait(50);

    // Esc handled by modal (reject), not by App's abort handler
    // resolveCommandApproval called with approved: false (modal rejection)
    expect(resolveCommandApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "appr-7", approved: false })
    );
    // Run is still running (not aborted) — modal Esc ≠ run abort
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("aborted");
    unmount();
  });
});

describe("PlanReadyModal", () => {
  let resolvePlanApproval: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ resolvePlanApproval } = await import("../../llm/planApprovals.js") as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const PLAN_STEPS = JSON.stringify([
    { title: "Read relevant files", description: "Understand scope", filesLikely: ["src/foo.ts", "src/bar.ts"] },
    { title: "Implement feature", description: "Write the code", filesLikely: ["src/baz.ts"] },
  ]);

  it("renders objective and steps on plan_ready_for_approval", async () => {
    const bus = createEventBus();
    const { lastFrame, unmount } = render(<App bus={bus} />);

    bus.emit("plan_ready_for_approval", makeEvt("plan_ready_for_approval", {
      planId: "plan-test-1",
      runId: "test-run",
      planObjective: "Add feature X to the codebase.",
      planStepsJson: PLAN_STEPS,
    }));
    await new Promise(r => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready to code?");
    expect(frame).toContain("Add feature X to the codebase.");
    expect(frame).toContain("Read relevant files");
    expect(frame).toContain("[1]");
    unmount();
  });

  it("key 1 resolves as accept_all and closes modal", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} />);

    bus.emit("plan_ready_for_approval", makeEvt("plan_ready_for_approval", {
      planId: "plan-test-2",
      runId: "test-run",
      planObjective: "Fix bug.",
      planStepsJson: PLAN_STEPS,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()).toContain("Ready to code?");

    stdin.write("1");
    await new Promise(r => setTimeout(r, 50));

    expect(resolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-test-2", decision: "accept_all" })
    );
    // Not "Ready to code?" — that header now also lives in the permanent transcript
    // entry (PLAN_READY_PROPOSED appends it to history) and is expected to survive
    // resolution by design. The footer hint is unique to the still-mounted modal's
    // own action-prompt chrome (PlanReadyModal.tsx), which does close on resolve.
    expect(lastFrame()).not.toContain("[1] auto-accept all");
    unmount();
  });

  it("key 2 resolves as manual and closes modal", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} />);

    bus.emit("plan_ready_for_approval", makeEvt("plan_ready_for_approval", {
      planId: "plan-test-3",
      runId: "test-run",
      planObjective: "Refactor something.",
      planStepsJson: PLAN_STEPS,
    }));
    await new Promise(r => setTimeout(r, 50));

    stdin.write("2");
    await new Promise(r => setTimeout(r, 50));

    expect(resolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-test-3", decision: "manual" })
    );
    // See the accept_all test above for why this checks the footer hint, not the header.
    expect(lastFrame()).not.toContain("[1] auto-accept all");
    unmount();
  });

  it("Esc resolves as reject, closes modal, and transitions to aborted", async () => {
    const bus = createEventBus();
    const { lastFrame, stdin, unmount } = render(<App bus={bus} />);

    bus.emit("agent_loop_start", makeEvt("agent_loop_start"));
    bus.emit("plan_ready_for_approval", makeEvt("plan_ready_for_approval", {
      planId: "plan-test-4",
      runId: "test-run",
      planObjective: "Something.",
      planStepsJson: PLAN_STEPS,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()).toContain("Ready to code?");

    stdin.write("\x1b");
    await new Promise(r => setTimeout(r, 50));

    expect(resolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-test-4", decision: "reject" })
    );
    // See the accept_all test above for why this checks the footer hint, not the header.
    expect(lastFrame()).not.toContain("[1] auto-accept all");
    expect(lastFrame()).toContain("aborted");
    unmount();
  });
});
