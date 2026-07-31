import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { render as inkRender } from "ink";
import { EventEmitter } from "node:events";
import { useEffect } from "react";
import React from "react";
import { PlanActionPrompt } from "./PlanActionPrompt.js";
import { StoreProvider, useStore } from "../store.js";
import type { StoreAction, StoreState } from "../store.js";
import { Composer } from "./Composer.js";

const mockResolvePlanApproval = vi.hoisted(() => vi.fn());
vi.mock("../../../llm/planApprovals.js", () => ({
  resolvePlanApproval: mockResolvePlanApproval,
}));

const PROPOSAL: NonNullable<StoreState["planReadyProposal"]> = {
  planId: "plan-1",
  runId: "run-1",
  objective: "Add a widget to the dashboard",
  steps: [{ title: "Create the widget", description: "New component", filesLikely: ["src/Widget.tsx"] }],
  riskHints: [],
  scopeSummary: "",
};

const ANSWER_ONLY_PROPOSAL: NonNullable<StoreState["planReadyProposal"]> = {
  planId: "plan-2",
  runId: "run-2",
  objective: "Explain the marker sink",
  steps: [],
  riskHints: [],
  scopeSummary: "Explain the marker sink",
  answerOnlyReason: "The task is a question; nothing needs to change.",
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

/**
 * ink-testing-library's own render() already supports useInput/usePaste (see
 * StagedDiffModal.test.tsx) and is used for every test here except the
 * column-width one below — PlanActionPrompt has no column-dependent
 * rendering at all (unlike the deleted PlanReadyModal, which used
 * useStdout() for its now-deleted budget math), so the custom stdout
 * override exists only to prove Ink itself doesn't do anything unexpected
 * to this fixed, unwrapped footer text at a narrower width.
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

function renderPlanActionPromptAt(
  proposal: StoreState["planReadyProposal"],
  dispatch: (action: StoreAction) => void,
  columns: number,
): { lastFrame: () => string | undefined; unmount: () => void } {
  let lastFrame: string | undefined;
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: 40,
    // isTTY: false on the STDOUT mock specifically — not stdin, which stays a
    // real raw-mode-capable TTY via MockStdin — matches the deleted
    // PlanReadyModal.test.tsx's own renderPlanReadyModalAt helper. Without
    // it, Ink writes the bracketed-paste-mode-enable escape sequence
    // ("\x1b[?2004h") as its own stdout.write call, which lands after the
    // real content paint and becomes the last thing this mock's write()
    // captures — the frame check below would see the escape code, not the
    // footer text, even though the actual rendered UI is correct.
    isTTY: false,
    write: (frame: string) => { lastFrame = frame; return true; },
  });
  const instance = inkRender(
    <PlanActionPrompt proposal={proposal} dispatch={dispatch} />,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { stdout: stdout as any, stdin: new MockStdin() as any, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  return { lastFrame: () => lastFrame, unmount: () => instance.unmount() };
}

describe("PlanActionPrompt — idle (no proposal)", () => {
  it("renders nothing when proposal is null", () => {
    const { lastFrame, unmount } = render(<PlanActionPrompt proposal={null} dispatch={makeDispatch()} />);
    activeUnmount = unmount;
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  it("a keypress with no proposal does not resolve anything", async () => {
    const { stdin, unmount } = render(<PlanActionPrompt proposal={null} dispatch={makeDispatch()} />);
    activeUnmount = unmount;
    stdin.write("1");
    await wait();
    expect(mockResolvePlanApproval).not.toHaveBeenCalled();
  });
});

describe("PlanActionPrompt — normal mode", () => {
  it("renders the footer with 4 numbered actions", () => {
    const { lastFrame, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={makeDispatch()} />);
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1]");
    expect(frame).toContain("[2]");
    expect(frame).toContain("[3]");
    expect(frame).toContain("[4]");
    expect(frame).toContain("Esc");
  });

  it("[1] calls resolvePlanApproval with accept_all and dispatches PLAN_READY_RESOLVED", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={dispatch} />);
    activeUnmount = unmount;
    stdin.write("1");
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1", runId: "run-1", decision: "accept_all" })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "PLAN_READY_RESOLVED" });
  });

  it("[2] calls resolvePlanApproval with manual", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={dispatch} />);
    activeUnmount = unmount;
    stdin.write("2");
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "manual" })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "PLAN_READY_RESOLVED" });
  });

  it("Esc calls resolvePlanApproval with reject and dispatches RUN_ABORTED", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={dispatch} />);
    activeUnmount = unmount;
    stdin.write("\x1b");
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "reject" })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "PLAN_READY_RESOLVED" });
    expect(dispatch).toHaveBeenCalledWith({ type: "RUN_ABORTED" });
  });

  it("[3] enters feedback mode (shows input prompt, hides normal footer)", async () => {
    const { lastFrame, stdin, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={makeDispatch()} />);
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Feedback (then revise):");
    expect(frame).not.toContain("[1] auto-accept all");
    expect(mockResolvePlanApproval).not.toHaveBeenCalled();
  });

  it("[4] enters feedback mode with the approve_with_feedback label", async () => {
    const { lastFrame, stdin, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={makeDispatch()} />);
    activeUnmount = unmount;
    stdin.write("4");
    await wait();
    expect(lastFrame() ?? "").toContain("Feedback (then run):");
  });
});

describe("PlanActionPrompt — feedback mode", () => {
  it("Esc returns to normal mode without resolving", async () => {
    const dispatch = makeDispatch();
    const { lastFrame, stdin, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={dispatch} />);
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(lastFrame() ?? "").toContain("[1] auto-accept all");
    expect(mockResolvePlanApproval).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("typing text then Enter submits the feedback decision with the typed text", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={dispatch} />);
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("looks good but split step 1");
    await wait();
    stdin.write("\r");
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "feedback", feedback: "looks good but split step 1" })
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "PLAN_READY_RESOLVED" });
  });

  it("[4] + type + Enter submits approve_with_feedback with the typed text", async () => {
    const { stdin, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={makeDispatch()} />);
    activeUnmount = unmount;
    stdin.write("4");
    await wait();
    stdin.write("go ahead");
    await wait();
    stdin.write("\r");
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approve_with_feedback", feedback: "go ahead" })
    );
  });

  it("paste in feedback mode inserts the full pasted text at the cursor", async () => {
    const { stdin, unmount } = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={makeDispatch()} />);
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("\x1b[200~pasted feedback\x1b[201~");
    await wait();
    stdin.write("\r");
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "feedback", feedback: "pasted feedback" })
    );
  });
});

describe("PlanActionPrompt — answer-only proposal (C7)", () => {
  it("renders the 3-action footer for an answer-shaped proposal, not the normal 4-action footer", () => {
    const { lastFrame, unmount } = render(<PlanActionPrompt proposal={ANSWER_ONLY_PROPOSAL} dispatch={makeDispatch()} />);
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1] answer now (read-only)  ·  [3] plan a fix instead  ·  Esc cancel");
    expect(frame).not.toContain("[2] manually approve changes");
  });

  it("[1] on an answer-shaped proposal still resolves accept_all — no new PlanDecision variant (D3)", async () => {
    const { stdin, unmount } = render(<PlanActionPrompt proposal={ANSWER_ONLY_PROPOSAL} dispatch={makeDispatch()} />);
    activeUnmount = unmount;
    stdin.write("1");
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "accept_all" })
    );
  });

  it("[3] feedback-mode hint reads 'plan a fix' for an answer-shaped proposal; the existing 'revise' hint is unchanged for a normal one", async () => {
    const answer = render(<PlanActionPrompt proposal={ANSWER_ONLY_PROPOSAL} dispatch={makeDispatch()} />);
    answer.stdin.write("3");
    await wait();
    expect(answer.lastFrame() ?? "").toContain("Feedback (then plan a fix):");
    answer.unmount();

    const normal = render(<PlanActionPrompt proposal={PROPOSAL} dispatch={makeDispatch()} />);
    normal.stdin.write("3");
    await wait();
    expect(normal.lastFrame() ?? "").toContain("Feedback (then revise):");
    normal.unmount();
  });
});

describe("PlanActionPrompt — column width", () => {
  it("renders the footer unbroken at 60 and 80 columns", async () => {
    for (const columns of [60, 80]) {
      const { lastFrame, unmount } = renderPlanActionPromptAt(PROPOSAL, makeDispatch(), columns);
      await wait();
      const frame = lastFrame() ?? "";
      expect(frame).toContain("[1]");
      expect(frame).toContain("[4]");
      unmount();
    }
  });
});

describe("PlanActionPrompt — Composer stays muted while a proposal is pending", () => {
  function Harness({ onSubmit }: { onSubmit: (text: string) => void }): React.ReactElement {
    const { state, dispatch } = useStore();
    useEffect(() => {
      dispatch({
        type: "PLAN_READY_PROPOSED",
        planId: PROPOSAL.planId,
        runId: PROPOSAL.runId,
        objective: PROPOSAL.objective,
        steps: PROPOSAL.steps,
        riskHints: PROPOSAL.riskHints,
        scopeSummary: PROPOSAL.scopeSummary,
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <>
        <Composer onSubmit={onSubmit} onExit={() => {}} />
        <PlanActionPrompt proposal={state.planReadyProposal} dispatch={dispatch} />
      </>
    );
  }

  it("pressing '1' resolves accept_all AND leaves the Composer buffer untouched", async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
        <Harness onSubmit={onSubmit} />
      </StoreProvider>
    );
    activeUnmount = unmount;
    await wait(); // let the mount-time PLAN_READY_PROPOSED dispatch land before sending input

    stdin.write("1");
    await wait();

    // Positive first: PlanActionPrompt's own capture actually worked.
    expect(mockResolvePlanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ planId: PROPOSAL.planId, decision: "accept_all" })
    );
    // Negative: Composer's guard (state.modalView !== "none", set by
    // PLAN_READY_PROPOSED to "plan_ready") kept the same keystroke out of its
    // own input buffer — the placeholder still shows, meaning the buffer is
    // still empty, not holding a stray "1".
    expect(lastFrame() ?? "").toContain("Type a task or /help");
  });
});
