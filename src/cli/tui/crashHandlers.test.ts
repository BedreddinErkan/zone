/**
 * Crash handlers must persist the session and must still exit (ledger item 353).
 *
 * Before the extraction these two handlers were unreachable from the suite — they were registered
 * inside runTui, which renders Ink and awaits waitUntilExit() — so deleting either passed. The
 * cases below are the double-fault locks the signal path already carries, applied to the path that
 * lacked them: a save added to a crash handler is only safe if a throw inside the save cannot stop
 * the exit.
 */

import { describe, it, expect } from "vitest";
import { registerCrashHandlers, type CrashHandlerDeps } from "./index.js";

type Handler = (err: unknown) => void;

function harness(over: Partial<CrashHandlerDeps> = {}) {
  const handlers: Record<string, Handler> = {};
  const calls = {
    saved: [] as unknown[],
    exits: [] as number[],
    unmounts: 0,
    reported: [] as unknown[],
    logs: [] as Array<[string, string]>,
  };
  const deps: CrashHandlerDeps = {
    getState: () => ({ transcript: [{ kind: "user_prompt" }], sessionId: "sess-1234" }),
    buildSession: () => ({ version: 1, sessionId: "sess-1234" }),
    saveSessionSync: (_c, session) => { calls.saved.push(session); return "f.json"; },
    stopRemoteControlServer: () => undefined,
    unmount: () => { calls.unmounts += 1; },
    reportError: (e) => { calls.reported.push(e); },
    exit: (code) => { calls.exits.push(code); },
    on: (event, h) => { handlers[event] = h; },
    cwd: () => "/tmp/repo",
    log: (name, payload) => { calls.logs.push([name, payload]); },
    ...over,
  };
  registerCrashHandlers(deps);
  return { handlers, calls };
}

describe("registerCrashHandlers — both events are wired", () => {
  it("registers exactly uncaughtException and unhandledRejection", () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual(["uncaughtException", "unhandledRejection"]);
  });

  it("saves the session and exits 1 on each event", () => {
    for (const event of ["uncaughtException", "unhandledRejection"]) {
      const { handlers, calls } = harness();
      handlers[event]!(new Error("boom"));
      expect(calls.saved).toHaveLength(1);
      expect(calls.exits).toEqual([1]);
    }
  });
});

describe("the save cannot stop the exit — the locks the signal path already had", () => {
  it("a throwing unmount does NOT prevent the save", () => {
    const { handlers, calls } = harness({ unmount: () => { throw new Error("terminal gone"); } });
    handlers["uncaughtException"]!(new Error("boom"));
    expect(calls.saved).toHaveLength(1);
    expect(calls.exits).toEqual([1]);
  });

  it("a throwing buildSession reports phase=build, never writes, and still exits", () => {
    const { handlers, calls } = harness({ buildSession: () => { throw new Error("cwd gone"); } });
    handlers["uncaughtException"]!(new Error("boom"));
    expect(calls.saved).toHaveLength(0);
    expect(calls.logs.some(([, p]) => p.includes('"phase":"build"'))).toBe(true);
    expect(calls.exits).toEqual([1]);
  });

  it("a throwing saveSessionSync reports phase=write and still exits", () => {
    const { handlers, calls } = harness({ saveSessionSync: () => { throw new Error("ENOSPC"); } });
    handlers["uncaughtException"]!(new Error("boom"));
    expect(calls.logs.some(([, p]) => p.includes('"phase":"write"'))).toBe(true);
    expect(calls.exits).toEqual([1]);
  });

  it("a throwing log inside the failure reporting still allows exit", () => {
    const { handlers, calls } = harness({
      saveSessionSync: () => { throw new Error("ENOSPC"); },
      log: () => { throw new Error("EPIPE"); },
    });
    handlers["uncaughtException"]!(new Error("boom"));
    expect(calls.exits).toEqual([1]);
  });

  it("a throwing reportError still allows exit", () => {
    const { handlers, calls } = harness({ reportError: () => { throw new Error("EPIPE"); } });
    handlers["uncaughtException"]!(new Error("boom"));
    expect(calls.exits).toEqual([1]);
  });

  it("an empty transcript writes nothing but still exits", () => {
    const { handlers, calls } = harness({ getState: () => ({ transcript: [], sessionId: "s" }) });
    handlers["uncaughtException"]!(new Error("boom"));
    expect(calls.saved).toHaveLength(0);
    expect(calls.exits).toEqual([1]);
  });

  it("a null state — the pre-mount window — writes nothing and still exits", () => {
    const { handlers, calls } = harness({ getState: () => null });
    handlers["uncaughtException"]!(new Error("boom"));
    expect(calls.saved).toHaveLength(0);
    expect(calls.exits).toEqual([1]);
  });

  it("a build that SUCCEEDS but returns a falsy session is still written — this is what the built flag is for", () => {
    // `if (built)` and `if (session)` behave identically whenever the build throws, so every other
    // case in this file passes under either. They diverge only here, on a successful build whose
    // result happens to be falsy — which is precisely the distinction the flag exists to make, and
    // the mutation swapping it survived until this case existed.
    const { handlers, calls } = harness({ buildSession: () => null });
    handlers["uncaughtException"]!(new Error("boom"));
    expect(calls.saved).toEqual([null]);
    expect(calls.exits).toEqual([1]);
  });

  it("negative control — the MCP kill is attempted, and its absence is not what these cases assert", () => {
    // Guards against a fix that satisfies every assertion above by skipping the pre-save steps.
    let killed = 0;
    const { handlers } = harness({
      getState: () => ({ transcript: [{}], sessionId: "s", armedMcpManager: { killAllSync: () => { killed += 1; } } }),
    });
    handlers["uncaughtException"]!(new Error("boom"));
    expect(killed).toBe(1);
  });
});
