import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { StagedDiffModal } from "./StagedDiffModal.js";

const mockResolveStagedApproval = vi.hoisted(() => vi.fn().mockReturnValue({ ok: true }));

vi.mock("../../../api/stagedApprovals.js", () => ({
  resolveStagedApproval: mockResolveStagedApproval,
}));

// DiffView parses --- FIND --- / --- REPLACE --- blocks.
// For test purposes render a simple patch that produces visible output.
const SIMPLE_PATCH = "--- FIND ---\nold line\n--- REPLACE ---\nnew line";

const PROPOSAL = {
  approvalId: "approval-001",
  runId: "run-001",
  files: [
    { path: "src/foo.ts", findReplace: SIMPLE_PATCH, added: 1, removed: 1 },
    { path: "src/bar.ts", findReplace: SIMPLE_PATCH, added: 2, removed: 0 },
  ],
  verificationSummary: "tsc ✓",
  trigger: "natural_completion",
};

function makeDispatch() {
  return vi.fn();
}

function wait(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let activeUnmount: (() => void) | null = null;

beforeEach(() => {
  mockResolveStagedApproval.mockClear();
  activeUnmount = null;
});

afterEach(() => {
  activeUnmount?.();
  activeUnmount = null;
});

describe("StagedDiffModal — render", () => {
  it("renders title, trigger label, and verificationSummary", () => {
    const { lastFrame, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Review staged changes");
    expect(frame).toContain("Task complete");
    expect(frame).toContain("tsc ✓");
  });

  it("renders 'Iteration limit reached' for max_iterations trigger", () => {
    const { lastFrame, unmount } = render(
      <StagedDiffModal proposal={{ ...PROPOSAL, trigger: "max_iterations" }} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Iteration limit reached");
  });

  it("renders file paths with +added −removed counts", () => {
    const { lastFrame, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("src/foo.ts");
    expect(frame).toContain("src/bar.ts");
    expect(frame).toContain("+1");
    expect(frame).toContain("+2");
  });

  it("renders action hint line with 4 actions", () => {
    const { lastFrame, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1] apply all");
    expect(frame).toContain("[2] approve per-file");
    expect(frame).toContain("[3] refine");
    expect(frame).toContain("Esc reject");
  });
});

describe("StagedDiffModal — normal mode actions", () => {
  it("[1] calls resolveStagedApproval with approve_all and dispatches STAGED_DIFFS_RESOLVED", () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("1");
    expect(mockResolveStagedApproval).toHaveBeenCalledWith({
      approvalId: "approval-001",
      runId: "run-001",
      decision: "approve_all",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "STAGED_DIFFS_RESOLVED" });
  });

  it("[2] calls resolveStagedApproval with manual and dispatches STAGED_DIFFS_RESOLVED", () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("2");
    expect(mockResolveStagedApproval).toHaveBeenCalledWith({
      approvalId: "approval-001",
      runId: "run-001",
      decision: "manual",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "STAGED_DIFFS_RESOLVED" });
  });

  it("Esc calls resolveStagedApproval with reject, dispatches STAGED_DIFFS_RESOLVED and RUN_ABORTED", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("\x1b");
    await wait();
    expect(mockResolveStagedApproval).toHaveBeenCalledWith({
      approvalId: "approval-001",
      runId: "run-001",
      decision: "reject",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "STAGED_DIFFS_RESOLVED" });
    expect(dispatch).toHaveBeenCalledWith({ type: "RUN_ABORTED" });
  });
});

describe("StagedDiffModal — feedback sub-mode", () => {
  it("[3] enters feedback mode (shows input prompt, hides action hint)", async () => {
    const { lastFrame, stdin, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Refine (describe changes):");
    expect(frame).toContain("Enter to submit");
    expect(frame).not.toContain("[1] apply all");
    expect(mockResolveStagedApproval).not.toHaveBeenCalled();
  });

  it("Esc in feedback mode returns to normal mode without resolving", async () => {
    const { lastFrame, stdin, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("\x1b");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1] apply all");
    expect(mockResolveStagedApproval).not.toHaveBeenCalled();
  });

  it("type + Enter submits refine decision with typed feedback", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("use async/await");
    await wait();
    stdin.write("\r");
    await wait();
    expect(mockResolveStagedApproval).toHaveBeenCalledWith({
      approvalId: "approval-001",
      runId: "run-001",
      decision: "refine",
      feedback: "use async/await",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "STAGED_DIFFS_RESOLVED" });
  });

  it("paste in feedback mode inserts pasted text at cursor", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <StagedDiffModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("\x1b[200~pasted feedback\x1b[201~");
    await wait();
    stdin.write("\r");
    await wait();
    expect(mockResolveStagedApproval).toHaveBeenCalledWith({
      approvalId: "approval-001",
      runId: "run-001",
      decision: "refine",
      feedback: "pasted feedback",
    });
  });
});
