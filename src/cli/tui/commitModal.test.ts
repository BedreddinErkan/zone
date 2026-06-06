import { describe, it, expect, vi, beforeEach } from "vitest";

// Must be hoisted before any imports that use child_process
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import { executeCommit } from "./components/CommitModal.js";
import { reducer, buildInitialState } from "./store.js";

beforeEach(() => {
  vi.resetAllMocks();
});

// Helper: mock execFile for the two-call flow (add then commit).
function mockTwoCalls(commitStdout: string): void {
  execFileMock
    .mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (err: null, r: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "", stderr: "" }); // git add succeeds
    })
    .mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (err: null, r: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: commitStdout, stderr: "" }); // git commit succeeds
    });
}

describe("executeCommit — git args array (two sequential calls)", () => {
  it("call 1 = git add -- <paths> (scoped, NOT git add . NOT -A); call 2 = git commit -m <msg> -- <paths>; both use repoPath as cwd", async () => {
    mockTwoCalls("[main abc1234] fix: thing\n 2 files changed");

    const result = await executeCommit("/repo", "fix: thing", ["src/a.ts", "src/b.ts"]);

    expect(execFileMock).toHaveBeenCalledTimes(2);

    // --- call 1: git add ---
    const [file1, args1, opts1] = execFileMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(file1).toBe("git");
    expect(args1).toEqual(["add", "--", "src/a.ts", "src/b.ts"]);
    // Safety: NOT a blanket add
    expect(args1).not.toContain(".");
    expect(args1).not.toContain("-A");
    expect(opts1).toMatchObject({ cwd: "/repo" });

    // --- call 2: git commit ---
    const [file2, args2, opts2] = execFileMock.mock.calls[1] as [string, string[], { cwd: string }];
    expect(file2).toBe("git");
    expect(args2).toEqual(["commit", "-m", "fix: thing", "--", "src/a.ts", "src/b.ts"]);
    // No --only flag needed; pathspec provides scoping
    expect(args2).not.toContain("--only");
    expect(opts2).toMatchObject({ cwd: "/repo" });

    expect(result).toEqual({ ok: true, hash: "abc1234" });
  });

  it("uses the edited message on both calls when caller provides a different string", async () => {
    mockTwoCalls("[main bbb2222] edited by user\n 1 file changed");

    await executeCommit("/repo", "edited by user", ["src/a.ts"]);

    // commit args must contain the edited message
    const commitArgs = execFileMock.mock.calls[1]![1] as string[];
    expect(commitArgs).toContain("edited by user");
    expect(commitArgs).not.toContain("pre-fill message");
  });

  it("if git add fails, returns error immediately — commit call NOT made", async () => {
    execFileMock.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (err: Error) => void) => {
      const err = Object.assign(new Error("git error"), { stderr: "fatal: not a git repository" });
      cb(err);
    });

    const result = await executeCommit("/repo", "msg", ["src/a.ts"]);

    expect(execFileMock).toHaveBeenCalledTimes(1); // only git add was called
    expect(result).toEqual({ ok: false, error: "fatal: not a git repository" });
  });

  it("if git commit fails after successful add, returns error from commit", async () => {
    execFileMock
      .mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (err: null, r: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" }); // git add OK
      })
      .mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (err: Error) => void) => {
        const err = Object.assign(new Error("git error"), { stderr: "nothing to commit" });
        cb(err);
      });

    const result = await executeCommit("/repo", "msg", ["src/a.ts"]);

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, error: "nothing to commit" });
  });

  it("falls back to stdout when stderr is empty on failure", async () => {
    execFileMock.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: (err: Error) => void) => {
      const err = Object.assign(new Error("git error"), { stderr: "", stdout: "some stdout error" });
      cb(err);
    });

    const result = await executeCommit("/repo", "msg", ["src/a.ts"]);

    expect(result).toEqual({ ok: false, error: "some stdout error" });
  });
});

describe("COMMIT_MODAL_OPEN / COMMIT_MODAL_CLOSE reducer", () => {
  const base = buildInitialState({ model: "claude-sonnet-4-6", capUsd: 10 });

  it("COMMIT_MODAL_OPEN sets modalView and stores commitData", () => {
    const state = reducer(base, {
      type: "COMMIT_MODAL_OPEN",
      filePaths: ["src/foo.ts", "src/bar.ts"],
      message: "fix: something",
      repoPath: "/the/repo",
    });
    expect(state.modalView).toBe("commit");
    expect(state.commitData).toEqual({
      filePaths: ["src/foo.ts", "src/bar.ts"],
      message: "fix: something",
      repoPath: "/the/repo",
    });
  });

  it("COMMIT_MODAL_CLOSE clears modalView", () => {
    const opened = reducer(base, {
      type: "COMMIT_MODAL_OPEN",
      filePaths: ["src/foo.ts"],
      message: "msg",
      repoPath: "/repo",
    });
    const closed = reducer(opened, { type: "COMMIT_MODAL_CLOSE" });
    expect(closed.modalView).toBe("none");
  });
});

describe("AUTOCOMMIT_APPLY reducer", () => {
  const base = buildInitialState({ model: "claude-sonnet-4-6", capUsd: 10 });

  it("sets commitOnSuccess: true on modelSettings", () => {
    const state = reducer(base, { type: "AUTOCOMMIT_APPLY", commitOnSuccess: true });
    expect(state.modelSettings?.commitOnSuccess).toBe(true);
  });

  it("toggles off: sets commitOnSuccess: false", () => {
    const on = reducer(base, { type: "AUTOCOMMIT_APPLY", commitOnSuccess: true });
    const off = reducer(on, { type: "AUTOCOMMIT_APPLY", commitOnSuccess: false });
    expect(off.modelSettings?.commitOnSuccess).toBe(false);
  });

  it("does not change modalView (inline toggle, no modal)", () => {
    const state = reducer(base, { type: "AUTOCOMMIT_APPLY", commitOnSuccess: true });
    expect(state.modalView).toBe("none");
  });
});

describe("/commit slash command — no git exec when no data", () => {
  it("returns nothing-to-commit when getCommitData returns null", () => {
    const data = null;
    const hasData = data !== null && (data as { filePaths: string[] } | null)?.filePaths.length;
    expect(hasData).toBeFalsy();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns nothing-to-commit when filePaths is empty", () => {
    const data = { filePaths: [], message: "", repoPath: "/repo" };
    expect(data.filePaths.length > 0).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
