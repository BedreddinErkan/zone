import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Confirms, rather than assumes, what ledger item 258's fix actually changes for
 * `promptScopeRevision` — and the two paths change in different, precise ways, not the one thing
 * "the message becomes true" would suggest if read too broadly.
 *
 * On the non-TTY path, the OUTCOME is unchanged either way: `decision: "reject"` fires whether
 * `noRevision` is true (first branch, early return) or false (falls through to the non-TTY
 * branch, which also rejects). What changes is the SIDE EFFECT — the "Use --yes to approve or
 * --no-revision to suppress" warning printed unconditionally before the fix (every non-TTY run
 * reached the third branch, since the first branch's `opts.noRevision` was always falsy) and now
 * prints only when the user has NOT already passed the flag it recommends. Before the fix, a user
 * who followed the advice saw the advice anyway, every time, forever — self-contradictory rather
 * than false. That is what "becomes true" means here: not a changed outcome, a stopped
 * contradiction.
 *
 * On the TTY path, the outcome DOES change: before the fix `noRevision` was always falsy
 * regardless of the flag, so a TTY session always reached the interactive prompt. After the fix,
 * `--no-revision` on a TTY session short-circuits to `decision: "reject"` without ever prompting —
 * this is where the fix is actually observable to a user, not the non-TTY path.
 */

const mocks = vi.hoisted(() => ({
  resolveRevisionApproval: vi.fn(),
  createInterface: vi.fn(),
}));

vi.mock("../llm/revisionApprovals.js", () => ({
  resolveRevisionApproval: mocks.resolveRevisionApproval,
}));
vi.mock("node:readline", () => ({ createInterface: mocks.createInterface }));

const { promptScopeRevision } = await import("./approvals.js");

const spinner = { pauseForPrompt: vi.fn(), resumeAfterPrompt: vi.fn() } as any;

afterEach(() => {
  mocks.resolveRevisionApproval.mockReset();
  mocks.createInterface.mockReset();
});

describe("promptScopeRevision — TTY path: the fix is observable here", () => {
  it("noRevision=true short-circuits to reject WITHOUT ever prompting", async () => {
    mocks.createInterface.mockImplementation(() => {
      throw new Error("readline must not be reached when noRevision short-circuits");
    });
    await promptScopeRevision("rev-1", "summary", "run-1", {
      autoApprove: false,
      noRevision: true,
      isTTY: true,
      noColor: true,
    }, spinner);
    expect(mocks.resolveRevisionApproval).toHaveBeenCalledWith({
      revisionId: "rev-1",
      runId: "run-1",
      decision: "reject",
    });
    expect(mocks.createInterface).not.toHaveBeenCalled();
  });

  it("noRevision=false (the pre-fix-equivalent value) DOES reach the interactive prompt", async () => {
    const question = vi.fn((_prompt: string, cb: (a: string) => void) => cb("n"));
    mocks.createInterface.mockReturnValue({ question, close: vi.fn() });
    await promptScopeRevision("rev-2", "summary", "run-2", {
      autoApprove: false,
      noRevision: false,
      isTTY: true,
      noColor: true,
    }, spinner);
    expect(mocks.createInterface).toHaveBeenCalled();
    expect(question).toHaveBeenCalled();
  });
});

describe("promptScopeRevision — non-TTY path: outcome unchanged, side effect stopped", () => {
  it("noRevision=true: rejects, and the redundant warning does not print", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await promptScopeRevision("rev-3", "summary", "run-3", {
        autoApprove: false,
        noRevision: true,
        isTTY: false,
        noColor: true,
      }, spinner);
      expect(mocks.resolveRevisionApproval).toHaveBeenCalledWith({
        revisionId: "rev-3",
        runId: "run-3",
        decision: "reject",
      });
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("noRevision=false: rejects too — the SAME outcome — but the warning prints, recommending the flag the user has not used", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await promptScopeRevision("rev-4", "summary", "run-4", {
        autoApprove: false,
        noRevision: false,
        isTTY: false,
        noColor: true,
      }, spinner);
      expect(mocks.resolveRevisionApproval).toHaveBeenCalledWith({
        revisionId: "rev-4",
        runId: "run-4",
        decision: "reject",
      });
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Use --yes to approve or --no-revision to suppress")
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
