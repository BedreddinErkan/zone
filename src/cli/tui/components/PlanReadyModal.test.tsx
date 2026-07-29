import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { render as inkRender } from "ink";
import { EventEmitter } from "node:events";
import React from "react";
import { PlanReadyModal } from "./PlanReadyModal.js";
import type { StoreAction } from "../store.js";

/**
 * ink-testing-library hardcodes columns=100, which masks width-squeeze bugs.
 * `staticHarness.tsx:renderTranscriptAt` uses the same override-stdout
 * technique but is wired specifically to <Transcript />, which never calls
 * useInput — PlanReadyModal does, so a stdout-only mock isn't enough: Ink's
 * useInput calls stdin.setRawMode, and without it Ink catches the throw and
 * re-renders an error frame ("Raw mode is not supported…"), silently
 * replacing the real content. The stdin shape below is copied from
 * ink-testing-library's own internal mock (node_modules/ink-testing-library/
 * build/index.js) — the minimum Ink's input handling requires.
 */
class MockStdin extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

function renderPlanReadyModalAt(
  proposal: React.ComponentProps<typeof PlanReadyModal>["proposal"],
  dispatch: (action: StoreAction) => void,
  columns: number,
): { lastFrame: () => string | undefined; unmount: () => void } {
  let lastFrame: string | undefined;
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: 40,
    write: (frame: string) => { lastFrame = frame; return true; },
  });
  const instance = inkRender(
    <PlanReadyModal proposal={proposal} dispatch={dispatch} />,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { stdout: stdout as any, stdin: new MockStdin() as any, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  return {
    lastFrame: () => lastFrame,
    unmount: () => instance.unmount(),
  };
}

const mockResolvePlanApproval = vi.hoisted(() => vi.fn().mockReturnValue({ ok: true }));

vi.mock("../../../llm/planApprovals.js", () => ({
  resolvePlanApproval: mockResolvePlanApproval,
}));

const PROPOSAL = {
  planId: "plan-modal-001",
  runId: "run-modal-001",
  objective: "Add a login feature",
  steps: [
    { title: "Add login route", description: "Create the route", filesLikely: ["src/routes/login.ts"] },
    { title: "Add tests", description: "Write tests", filesLikely: ["src/routes/login.test.ts"] },
  ],
};

function makeDispatch() {
  return vi.fn();
}

function wait(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let activeUnmount: (() => void) | null = null;

beforeEach(() => {
  mockResolvePlanApproval.mockClear();
  activeUnmount = null;
});

afterEach(() => {
  activeUnmount?.();
  activeUnmount = null;
});

describe("PlanReadyModal — normal mode", () => {
  it("renders plan objective and steps", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready to code?");
    expect(frame).toContain("Add a login feature");
    expect(frame).toContain("Add login route");
    expect(frame).toContain("Create the route");
  });

  it("truncates long step description at 200 chars", () => {
    const longDesc = "x".repeat(250);
    const proposal = {
      ...PROPOSAL,
      steps: [{ title: "Long step", description: longDesc, filesLikely: [] }],
    };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    // Count occurrences of "x" — robust to line-wrapping by Ink
    const xCount = (frame.match(/x/g) ?? []).length;
    expect(xCount).toBe(200);
  });

  it("renders footer with 4 numbered actions and no (stub) labels", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1]");
    expect(frame).toContain("[2]");
    expect(frame).toContain("[3]");
    expect(frame).toContain("[4]");
    expect(frame).not.toContain("stub");
  });

  it("[1] calls resolvePlanApproval with accept_all and no feedback", () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("1");
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "accept_all",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "PLAN_READY_RESOLVED" });
  });

  it("[2] calls resolvePlanApproval with manual", () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("2");
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "manual",
    });
  });

  it("Esc calls resolvePlanApproval with reject and dispatches RUN_ABORTED", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("\x1b");
    await wait(); // Ink may defer escape-sequence disambiguation
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "reject",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "RUN_ABORTED" });
  });
});

describe("PlanReadyModal — feedback sub-mode", () => {
  it("[3] enters feedback mode (shows input prompt, hides normal footer)", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Feedback (then revise):");
    expect(frame).toContain("Enter to submit");
    expect(frame).not.toContain("[1] auto-accept");
    expect(mockResolvePlanApproval).not.toHaveBeenCalled();
  });

  it("[4] enters feedback mode with approve_with_feedback label", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    stdin.write("4");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Feedback (then run):");
  });

  it("Esc in feedback mode returns to normal mode without resolving", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("\x1b");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1] auto-accept");
    expect(mockResolvePlanApproval).not.toHaveBeenCalled();
  });

  it("typing text then Enter submits feedback decision with typed text", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("add unit tests");
    await wait();
    stdin.write("\r"); // Enter
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "feedback",
      feedback: "add unit tests",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "PLAN_READY_RESOLVED" });
  });

  it("[4] + type + Enter submits approve_with_feedback with text", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("4");
    await wait();
    stdin.write("be concise");
    await wait();
    stdin.write("\r"); // Enter
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "approve_with_feedback",
      feedback: "be concise",
    });
  });

  it("paste in feedback mode inserts full pasted text at cursor", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("3");                                    // enter feedback mode
    await wait();
    stdin.write("\x1b[200~pasted feedback\x1b[201~");   // bracketed-paste sequence
    await wait();
    stdin.write("\r");                                   // submit
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "feedback",
      feedback: "pasted feedback",
    });
  });
});

// Phase 2a: scopeNotes rendering
describe("PlanReadyModal — scopeNotes", () => {
  it("renders 'Scope:' label and notes when scopeNotes is present on proposal", () => {
    const proposal = { ...PROPOSAL, scopeNotes: "Auth module 80% done in src/auth.ts" };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Scope:");
    expect(frame).toContain("Auth module 80% done");
  });

  it("does not render 'Scope:' when scopeNotes is absent", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Scope:");
  });

  it("truncates scopeNotes to 200 chars in render", () => {
    const longNotes = "x".repeat(300);
    const proposal = { ...PROPOSAL, scopeNotes: longNotes };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    // Ink wraps text across lines — count total x chars to verify cap
    const xCount = (frame.match(/x/g) ?? []).length;
    expect(xCount).toBe(200); // .slice(0, 200) applied — exactly 200 rendered
  });
});

// A replan can produce a stepless plan carrying noChangeReason/cannotVerifyReason
// (none of E8a/E8b/the forceSteps safety net in dispatch.ts re-run after a
// replan). The modal must show the reason, not just an empty step list.
describe("PlanReadyModal — stepless plan with a stated reason", () => {
  const STEPLESS_PROPOSAL = {
    ...PROPOSAL,
    steps: [],
  };

  it("renders 'No changes needed:' and the reason text when noChangeReason is set", () => {
    const proposal = { ...STEPLESS_PROPOSAL, noChangeReason: "Build already exits 0 — the asserted bug does not reproduce." };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No changes needed:");
    expect(frame).toContain("Build already exits 0");
    expect(frame).not.toContain("Could not verify:");
  });

  it("renders 'Could not verify:' and the reason text when cannotVerifyReason is set", () => {
    const proposal = { ...STEPLESS_PROPOSAL, cannotVerifyReason: "Reproduce command was blocked — could not confirm the premise." };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Could not verify:");
    expect(frame).toContain("Reproduce command was blocked");
    expect(frame).not.toContain("No changes needed:");
  });

  it("renders neither reason label on a normal multi-step plan", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("No changes needed:");
    expect(frame).not.toContain("Could not verify:");
  });

  it("truncates the reason text to 200 chars", () => {
    const longReason = "x".repeat(300);
    const proposal = { ...STEPLESS_PROPOSAL, noChangeReason: longReason };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    const xCount = (frame.match(/x/g) ?? []).length;
    expect(xCount).toBe(200);
  });

  it("still renders all four action keys — the reason changes visibility, not approval semantics", () => {
    const proposal = { ...STEPLESS_PROPOSAL, noChangeReason: "Verified clean." };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1]");
    expect(frame).toContain("[2]");
    expect(frame).toContain("[3]");
    expect(frame).toContain("[4]");
  });

  it("does not break the footer at 60 or 80 columns", () => {
    const proposal = { ...STEPLESS_PROPOSAL, cannotVerifyReason: "Reproduce command was blocked — could not confirm the premise." };
    for (const columns of [60, 80]) {
      const { lastFrame, unmount } = renderPlanReadyModalAt(proposal, makeDispatch(), columns);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Could not verify:");
      expect(frame).toContain("[1]");
      expect(frame).toContain("[4]");
      unmount();
    }
  });
});
