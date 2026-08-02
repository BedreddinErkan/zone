import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registerFatalSignalHandlers,
  FATAL_SIGNAL_EXIT_CODES,
  type FatalSignalDeps,
} from "./index.js";
import { saveSessionSync, _setSessionsDirForTest, type DiskSession } from "../../api/diskSessions.js";

/**
 * These handlers had NO test coverage before this file: they were registered inline inside
 * runTui, which renders Ink and awaits waitUntilExit(), so there was no seam to call them
 * from. That is why the extraction happened.
 *
 * What these tests establish and what they do NOT: they prove the listener is registered
 * per signal and does the right thing WHEN INVOKED, including that the write is durable
 * before the handler returns. They cannot prove the signal is delivered and handled before
 * the process dies — that rests only on real dogfood runs, one per signal, verified by
 * mtime.
 */

function makeSession(id = "s1"): DiskSession {
  return {
    version: 1, sessionId: id, startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(), cwd: "/tmp", model: "m",
    transcript: [], totalCostUsd: 0, totalTokens: 0, totalElapsedMs: 0,
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-sigsave-"));
  _setSessionsDirForTest(tmpDir);
});
afterEach(() => {
  _setSessionsDirForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<FatalSignalDeps> = {}) {
  const handlers = new Map<string, () => void>();
  const exit = vi.fn();
  const logged: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const deps: FatalSignalDeps = {
    getState: () => ({ transcript: [{ kind: "user" }] }) as never,
    buildSession: () => makeSession() as never,
    saveSessionSync: (cwd, session) => saveSessionSync(cwd, session as never),
    stopRemoteControlServer: vi.fn(),
    unmount: vi.fn(),
    stampEnvelopeOnExit: vi.fn(),
    exit,
    on: (sig, h) => { handlers.set(sig, h); },
    cwd: () => "/tmp/fake",
    log: (name, payload) => { logged.push({ name, payload: JSON.parse(payload) }); },
    readGuard: () => ({ listeners: 2, subscriberCount: 2 }),
    ...overrides,
  };
  registerFatalSignalHandlers(deps);
  return { handlers, exit, logged, deps };
}

const sessionFiles = () => fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));

describe("saveSessionSync", () => {
  it("writes a file that round-trips", () => {
    const name = saveSessionSync("/tmp/fake", makeSession("abcd1234"));
    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, name), "utf-8"));
    expect(sessionFiles()).toHaveLength(1);
    expect(written.sessionId).toBe("abcd1234");
  });
});

describe("registerFatalSignalHandlers", () => {
  it("registers SIGHUP — the signal tmux kill-session and a closing terminal both send", () => {
    const { handlers } = makeDeps();
    expect(handlers.has("SIGHUP")).toBe(true);
  });

  it("the session is on disk the moment the handler returns, with nothing awaited", () => {
    // THE assertion the old async path could not satisfy. signal-exit force-kills the
    // process right after our listener returns (signal-exit/index.js:121 -> :133), so any
    // write still in flight at that point is lost. No await here on purpose.
    const { handlers } = makeDeps();
    handlers.get("SIGHUP")!();
    expect(sessionFiles()).toHaveLength(1);
  });

  it("records both sides of signal-exit's guard, and which branch the run took", () => {
    const { handlers, logged } = makeDeps();
    handlers.get("SIGHUP")!();
    const guard = logged.find((l) => l.name === "[zone-signal-exit-guard]");
    expect(guard?.payload).toMatchObject({
      signal: "SIGHUP", listeners: 2, subscriberCount: 2, branch: "kills",
    });
  });

  it("reports 'stands_down' when the counts differ — a run that proves nothing about the fix", () => {
    // Recorded so a passing dogfood run in this branch is not mistaken for verification:
    // it would have survived on the old async path too.
    const { handlers, logged } = makeDeps({
      readGuard: () => ({ listeners: 2, subscriberCount: 1 }),
    });
    handlers.get("SIGINT")!();
    expect(logged.find((l) => l.name === "[zone-signal-exit-guard]")?.payload.branch)
      .toBe("stands_down");
  });

  it("an empty transcript writes nothing but still exits", () => {
    const { handlers, exit } = makeDeps({ getState: () => ({ transcript: [] }) as never });
    handlers.get("SIGHUP")!();
    expect(sessionFiles()).toHaveLength(0);
    expect(exit).toHaveBeenCalledWith(129);
  });

  it("REGRESSION LOCK: SIGINT still exits 130 and SIGTERM still 143", () => {
    const a = makeDeps();
    a.handlers.get("SIGINT")!();
    expect(a.exit).toHaveBeenCalledWith(130);

    const b = makeDeps();
    b.handlers.get("SIGTERM")!();
    expect(b.exit).toHaveBeenCalledWith(143);
  });

  it("a throwing unmount does NOT prevent the save — on SIGINT, a pre-existing path", () => {
    // The behavioral change to the two pre-existing signals, pinned rather than declared.
    const { handlers } = makeDeps({
      unmount: () => { throw new Error("EPIPE: terminal is gone"); },
    });
    expect(() => handlers.get("SIGINT")!()).not.toThrow();
    expect(sessionFiles()).toHaveLength(1);
  });

  it("a throwing saveSessionSync emits the marker with the real code and the firing signal", () => {
    const err = new Error("no space left on device") as NodeJS.ErrnoException;
    err.code = "ENOSPC";
    const { handlers, logged } = makeDeps({
      getState: () => ({ transcript: [{ kind: "user" }], sessionId: "sig-session-1" }) as never,
      saveSessionSync: () => { throw err; },
    });

    handlers.get("SIGTERM")!();

    const call = logged.find((l) => l.name === "[zone-session-save-failed]");
    expect(call?.payload.code).toBe("ENOSPC");
    expect(call?.payload.signal).toBe("SIGTERM");
  });

  it("exit still happens after saveSessionSync throws", () => {
    const { handlers, exit } = makeDeps({
      getState: () => ({ transcript: [{ kind: "user" }], sessionId: "sig-session-2" }) as never,
      saveSessionSync: () => { throw new Error("disk full"); },
    });

    handlers.get("SIGTERM")!();

    expect(exit).toHaveBeenCalledWith(143);
  });

  it("a successful sync save emits no failure marker", () => {
    const { handlers, logged } = makeDeps();

    handlers.get("SIGHUP")!();

    expect(logged.find((l) => l.name === "[zone-session-save-failed]")).toBeUndefined();
  });

  it("a throwing injected log inside the reporting itself still allows exit", () => {
    // The reporting call is wrapped in its own try/catch specifically so a secondary throw
    // (here, the log sink itself) can't prevent deps.exit(code) from running.
    const { handlers, exit } = makeDeps({
      getState: () => ({ transcript: [{ kind: "user" }], sessionId: "sig-session-3" }) as never,
      saveSessionSync: () => { throw new Error("disk full"); },
      log: (name) => {
        if (name === "[zone-session-save-failed]") throw new Error("log sink exploded");
      },
    });

    handlers.get("SIGTERM")!();

    expect(exit).toHaveBeenCalledWith(143);
  });

  it("buildSession throwing reports phase=build and never calls saveSessionSync", () => {
    const saveSessionSyncSpy = vi.fn();
    const { handlers, logged } = makeDeps({
      getState: () => ({ transcript: [{ kind: "user" }], sessionId: "sig-session-4" }) as never,
      buildSession: () => { throw new Error("ENOENT: no such file or directory, uv_cwd"); },
      saveSessionSync: saveSessionSyncSpy,
    });

    handlers.get("SIGHUP")!();

    const call = logged.find((l) => l.name === "[zone-session-save-failed]");
    expect(call?.payload.phase).toBe("build");
    expect(saveSessionSyncSpy).not.toHaveBeenCalled();
  });
});

describe("FATAL_SIGNAL_EXIT_CODES", () => {
  it("uses the conventional 128+signum for each signal", () => {
    expect(FATAL_SIGNAL_EXIT_CODES).toEqual({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });
  });
});
