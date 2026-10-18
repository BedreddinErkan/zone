import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { App } from "./App.js";
import { _runPromptImpl, type _RunPromptDeps } from "./index.js";
import { UiScheduler } from "./uiScheduler.js";
import { createEventBus } from "../eventBus.js";
import type { CliConfig } from "../config.js";
import type { StoreState } from "./store-core.js";
import type { OneShotOpts } from "../dispatch.js";
import type { ZoneStructuredProgressEvent as Event } from "../../core/agentLifecycleEvents.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), memory: vi.fn() }));
vi.mock("../dispatch.js", () => ({ runOneShotInner: mocks.run, buildResumeFlowInput: vi.fn() }));
vi.mock("../../llm/sessionWindow.js", async original => ({
  ...await original<typeof import("../../llm/sessionWindow.js")>(), buildSessionWindow: mocks.memory,
}));
vi.mock("../../core/conversationFilesystemStore.js", () => ({
  readFsConversationEvents: () => [], appendFsConversationEvent: async () => true,
}));
vi.mock("../../usage/usageTracker.js", () => ({ getUsage: async () => ({ totalCostUsd: 0 }) }));

let state: StoreState;
let deps: _RunPromptDeps;
let jobs: { id: string; opts: OneShotOpts; resolve: (result: unknown) => void; reject: (reason: Error) => void }[];
const wait = () => new Promise(resolve => setTimeout(resolve, 30));
const success = { ok: true, fileDiffs: [] };
function progress(job: typeof jobs[number], type: Event["type"], extra: Partial<Event> = {}) {
  job.opts.onProgress?.({ stage: type, progress: { runId: job.id, flowId: 1, iter: 1, ts: 1, title: type, type, ...extra } });
}

beforeEach(async () => {
  jobs = [];
  mocks.memory.mockReturnValue("");
  mocks.run.mockImplementation((_prompt, _config, id, opts) => new Promise((resolve, reject) => {
    jobs.push({ id, opts, resolve, reject });
    progress(jobs.at(-1)!, "agent_loop_start");
  }));
  const bus = createEventBus();
  deps = {
    config: { repoPath: "/tmp/zone-streaming-fixture", provider: "anthropic", model: "fixture", memoryEnabled: true, commitOnSuccess: false } as CliConfig,
    bus, scheduler: new UiScheduler(bus), localSessionId: "streaming-fixture",
    storeCapture: { state: null, dispatch: null, lastCommitData: null, lastFeedbackData: null },
  };
  render(<App bus={bus} initialConfig={{ ...deps.config, dailyCapUsd: 10 }}
    onDispatchCapture={dispatch => { deps.storeCapture.dispatch = dispatch; }}
    onStateChange={s => { state = s; deps.storeCapture.state = s; }} />);
  await wait();
});
afterEach(() => { deps.scheduler.stop(); cleanup(); });

describe("prompt execution → scheduler → App lifecycle", () => {
  it("registers before asynchronous memory loading and aborts without dispatching", async () => {
    let release!: (value: string) => void;
    mocks.memory.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const ac = new AbortController();
    const running = _runPromptImpl("task", ac, "normal", undefined, deps);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(state.execution?.open).toBe(true);
    ac.abort();
    release("");
    await running; await wait();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(state.runState).toBe("aborted");
    expect(state.execution?.open).toBe(false);
  });

  it("does not dispatch superseded asynchronous startup work", async () => {
    let release!: (value: string) => void;
    mocks.memory.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const old = _runPromptImpl("old", new AbortController(), "normal", undefined, deps);
    await vi.waitFor(() => expect(release).toBeDefined());
    const current = _runPromptImpl("new", new AbortController(), "normal", undefined, deps);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    deps.scheduler.flushNow(); await wait();
    release(""); await wait();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    await old;
    expect(state.execution?.runId).toBe(jobs[0]!.id);
    expect(state.runState).toBe("running");
    jobs[0]!.resolve(success); await current;
  });

  it("late abort, failure and finally from A cannot alter B", async () => {
    const ac = new AbortController();
    const old = _runPromptImpl("old", ac, "normal", undefined, deps);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    const current = _runPromptImpl("new", new AbortController(), "normal", undefined, deps);
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    progress(jobs[1]!, "chat_chunk", { delta: "new answer" });
    deps.scheduler.flushNow(); await wait();
    ac.abort();
    progress(jobs[0]!, "agent_loop_complete", { detail: "stale final" });
    jobs[0]!.reject(new Error("old failure"));
    await old; await wait();
    expect(state.execution?.runId).toBe(jobs[1]!.id);
    expect(state.execution?.open).toBe(true);
    expect(state.runState).toBe("running");
    expect(state.liveTail.streamingAnswer).toBe("new answer");
    expect(state.transcript.some(e => e.kind === "assistant_final" || e.kind === "error")).toBe(false);
    progress(jobs[1]!, "agent_loop_complete", { detail: "new final" });
    jobs[1]!.resolve(success); await current; await wait();
    expect(state.transcript.filter(e => e.kind === "assistant_final")).toEqual([{ kind: "assistant_final", text: "new final" }]);
    expect(state.execution?.open).toBe(false);
  });

  it("settles execution after flow 3 without discarding its queued authoritative final", async () => {
    const running = _runPromptImpl("task", new AbortController(), "normal", undefined, deps);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    progress(jobs[0]!, "chat_chunk", { flowId: 3, delta: "partial" });
    progress(jobs[0]!, "agent_loop_complete", { flowId: 3, detail: "authoritative" });
    jobs[0]!.resolve(success); await running; await wait();
    expect(state.runState).toBe("done");
    expect(state.execution).toMatchObject({ flowId: 3, open: false, flowClosed: true });
    expect(state.transcript.filter(e => e.kind === "assistant_final")).toHaveLength(1);
    progress(jobs[0]!, "agent_loop_start", { flowId: 4 });
    progress(jobs[0]!, "chat_chunk", { flowId: 4, delta: "late" });
    deps.scheduler.flushNow(); await wait();
    expect(state.liveTail.streamingAnswer).toBe("");
    expect(state.runState).toBe("done");
  });

  it("shows an execution-level error even after a higher flow has completed", async () => {
    const running = _runPromptImpl("task", new AbortController(), "normal", undefined, deps);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    progress(jobs[0]!, "agent_loop_complete", { flowId: 3, detail: "answer" });
    deps.scheduler.flushNow(); await wait();
    jobs[0]!.reject(new Error("post-processing failed"));
    await running; await wait();
    expect(state.runState).toBe("failed");
    expect(state.transcript).toContainEqual({ kind: "error", text: "post-processing failed" });
  });

  it("commits an alternate finalized chat response when execution settles", async () => {
    const running = _runPromptImpl("task", new AbortController(), "normal", undefined, deps);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    progress(jobs[0]!, "chat_response", { text: "complete response" });
    jobs[0]!.resolve(success); await running; await wait();
    expect(state.transcript).toContainEqual({ kind: "narration", text: "complete response" });
    expect(state.liveTail.narrationBuffer).toBe("");
    expect(state.execution?.open).toBe(false);
  });
});
