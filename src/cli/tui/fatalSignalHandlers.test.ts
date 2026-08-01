import { describe, it, expect, vi } from "vitest";
import {
  registerFatalSignalHandlers,
  FATAL_SIGNAL_EXIT_CODES,
  type FatalSignalDeps,
} from "./index.js";

/**
 * These handlers had NO test coverage before this file: they were registered inline
 * inside runTui, which renders Ink and awaits waitUntilExit(), so there was no seam to
 * call them from. That is why the extraction happened — a fourth copy for SIGHUP would
 * have been as untested as the two it copied.
 *
 * What these tests establish and what they do NOT: they prove the listener is registered
 * for each signal and does the right thing WHEN INVOKED. They cannot prove the signal is
 * actually delivered and handled before the process dies — that claim rests only on a
 * real dogfood run terminated by `tmux kill-session` with a session file on disk after.
 */

function makeDeps(overrides: Partial<FatalSignalDeps> = {}) {
  const handlers = new Map<string, () => void>();
  const saveSession = vi.fn(async () => undefined);
  const exit = vi.fn();
  const deps: FatalSignalDeps = {
    getState: () => ({ transcript: [{ kind: "user" }] }) as never,
    buildSession: () => ({ sessionId: "s1" }) as never,
    saveSession: saveSession as never,
    pruneOldSessions: vi.fn(async () => undefined) as never,
    stopRemoteControlServer: vi.fn(),
    unmount: vi.fn(),
    stampEnvelopeOnExit: vi.fn(),
    exit,
    on: (sig, h) => { handlers.set(sig, h); },
    cwd: () => "/tmp/fake",
    ...overrides,
  };
  registerFatalSignalHandlers(deps);
  return { handlers, saveSession, exit, deps };
}

/** The save is fire-and-forget inside the handler; let its promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("registerFatalSignalHandlers", () => {
  it("registers SIGHUP — the signal tmux kill-session and a closing terminal both send", () => {
    const { handlers } = makeDeps();
    expect(handlers.has("SIGHUP")).toBe(true);
  });

  it("SIGHUP saves the session and exits 129", async () => {
    const { handlers, saveSession, exit } = makeDeps();
    handlers.get("SIGHUP")!();
    await settle();
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(129);
  });

  it("an empty transcript skips the save but still exits", async () => {
    const { handlers, saveSession, exit } = makeDeps({
      getState: () => ({ transcript: [] }) as never,
    });
    handlers.get("SIGHUP")!();
    await settle();
    expect(saveSession).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(129);
  });

  it("REGRESSION LOCK: SIGINT still exits 130 and SIGTERM still 143", async () => {
    const { handlers, exit } = makeDeps();
    handlers.get("SIGINT")!();
    await settle();
    expect(exit).toHaveBeenCalledWith(130);

    const second = makeDeps();
    second.handlers.get("SIGTERM")!();
    await settle();
    expect(second.exit).toHaveBeenCalledWith(143);
  });

  it("a throwing unmount does NOT prevent the save — on SIGINT, a pre-existing path", async () => {
    // The behavioral change to the two pre-existing signals, pinned rather than declared.
    // unmount() runs before the save and writes escape sequences to stdout; under SIGHUP
    // that terminal is already gone. Unwrapped, a throw there skipped the save entirely —
    // the exact failure being fixed. Asserted on SIGINT specifically because that is the
    // path this change alters without being the path it was written for, and losing a
    // session on every signal matters more than losing it on one.
    const { handlers, saveSession } = makeDeps({
      unmount: () => { throw new Error("EPIPE: terminal is gone"); },
    });
    expect(() => handlers.get("SIGINT")!()).not.toThrow();
    await settle();
    expect(saveSession).toHaveBeenCalledTimes(1);
  });
});

describe("FATAL_SIGNAL_EXIT_CODES", () => {
  it("uses the conventional 128+signum for each signal", () => {
    expect(FATAL_SIGNAL_EXIT_CODES).toEqual({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });
  });
});
