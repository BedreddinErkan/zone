import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { App } from "./App.js";
import { UiScheduler } from "./uiScheduler.js";
import { createEventBus } from "../eventBus.js";
import type { StoreAction, StoreState } from "./store-core.js";
import type { ZoneStructuredProgressEvent as Event } from "../../core/agentLifecycleEvents.js";

let scheduler: UiScheduler;
let state: StoreState;
let dispatch: React.Dispatch<StoreAction>;
let screen: ReturnType<typeof render>;
let emitted: Event[];
let commits: number;
let bus: ReturnType<typeof createEventBus>;

async function settle() {
  await vi.advanceTimersByTimeAsync(32);
  for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

function send(type: Event["type"], extra: Partial<Event> & { flowId?: number } = {}) {
  scheduler.enqueue({ runId: "A", flowId: 1, iter: 1, ts: Date.now(), title: type, type, ...extra } as Event);
}

function begin(runId = "A", ac = new AbortController()) {
  scheduler.beginRun(runId, ac.signal);
  dispatch({ type: "EXECUTION_REGISTERED", runId });
  send("agent_loop_start", { runId });
  return ac;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  emitted = [];
  commits = 0;
  bus = createEventBus();
  const emit = bus.emit.bind(bus);
  bus.emit = (type, event) => { emitted.push(event); emit(type, event); };
  scheduler = new UiScheduler(bus);
  screen = render(<App bus={bus} onDispatchCapture={d => { dispatch = d; }}
    onStateChange={s => { state = s; commits++; }} />);
  await settle();
  scheduler.start();
  begin();
  await settle();
});

afterEach(() => { scheduler.stop(); cleanup(); vi.useRealTimers(); });

describe("scheduler → App streaming ownership", () => {
  it("appends fragments exactly once across ticks, preserving metadata", async () => {
    send("chat_chunk", { delta: "Hel", ts: 123 });
    await settle();
    send("chat_chunk", { delta: "lo" });
    await settle();
    expect(state.liveTail.streamingAnswer).toBe("Hello");
    expect(emitted.find(e => e.type === "chat_chunk")).toMatchObject({ runId: "A", flowId: 1, iter: 1, ts: 123, delta: "Hel" });
    expect(state.transcript).toHaveLength(0);
  });

  it("idle ticks and repeated flushes produce no events or store commits", async () => {
    send("chat_chunk", { delta: "quiet" });
    await settle();
    const events = emitted.length;
    const renders = commits;
    scheduler.flushNow(); scheduler.flushNow();
    await settle();
    expect(emitted).toHaveLength(events);
    expect(commits).toBe(renders);
  });

  it("resets between iterations and rejects fragments from an earlier iteration", async () => {
    send("chat_chunk", { delta: "old" }); await settle();
    send("chat_chunk", { iter: 2, delta: "new" }); await settle();
    send("chat_chunk", { iter: 1, delta: "late" }); await settle();
    expect(state.liveTail.streamingAnswer).toBe("new");
  });

  it("isolates runs and rejects old completion and cleanup", async () => {
    const old = begin();
    send("chat_chunk", { delta: "old" }); await settle();
    begin("B");
    send("chat_chunk", { runId: "B", delta: "new" }); await settle();
    old.abort();
    scheduler.finishRun("A");
    dispatch({ type: "EXECUTION_SETTLED", runId: "A" });
    send("agent_loop_complete", { runId: "A", detail: "STALE FINAL" }); await settle();
    // Also bypass scheduler admission: the reducer must independently reject it.
    bus.emit("agent_loop_complete", { runId: "A", flowId: 9, ts: 1, type: "agent_loop_complete", title: "late", detail: "STALE DIRECT FINAL" });
    bus.emit("run_failed", { runId: "A", ts: 2, type: "run_failed", title: "late failure" });
    await settle();
    expect(state.runState).toBe("running");
    expect(state.liveTail.streamingAnswer).toBe("new");
    expect(state.transcript.some(e => e.kind === "assistant_final")).toBe(false);
  });

  it("Escape permanently retires preview, including queued and late text", async () => {
    send("chat_chunk", { delta: "partial" }); await settle();
    send("chat_chunk", { delta: "queued" });
    screen.stdin.write("\x1b"); await settle();
    send("chat_chunk", { delta: "late" }); await settle();
    expect(state.runState).toBe("aborted");
    expect(state.liveTail.streamingAnswer).toBe("");
  });

  it("finalizes once and permits a distinct later flow in the same execution", async () => {
    send("chat_chunk", { delta: "partial" }); await settle();
    send("agent_loop_complete", { detail: "final one" }); await settle();
    send("agent_loop_complete", { detail: "final one" }); await settle();
    expect(state.liveTail.streamingAnswer).toBe("");
    expect(state.transcript.filter(e => e.kind === "assistant_final")).toHaveLength(1);
    send("agent_loop_start", { flowId: 2 });
    send("chat_chunk", { flowId: 2, delta: "second flow" }); await settle();
    send("agent_loop_complete", { flowId: 1, detail: "late first" }); await settle();
    send("run_failed", { flowId: 1, userMessage: "old flow failure" }); await settle();
    expect(state.runState).toBe("running");
    expect(state.liveTail.streamingAnswer).toBe("second flow");
    send("agent_loop_complete", { flowId: 2, detail: "final two" }); await settle();
    expect(state.transcript.filter(e => e.kind === "assistant_final")).toHaveLength(2);
  });

  it("execution settlement is run scoped, independent of flow 0, and cannot reopen", async () => {
    send("chat_chunk", { flowId: 3, delta: "third" }); await settle();
    dispatch({ type: "EXECUTION_SETTLED", runId: "A" });
    send("agent_loop_start", { flowId: 4 });
    send("chat_chunk", { flowId: 4, delta: "must not reopen" }); await settle();
    expect(state.runState).toBe("done");
    expect(state.liveTail.streamingAnswer).toBe("");
  });

  it("keeps tools before later narration and retires the old preview", async () => {
    send("chat_chunk", { delta: "inspection" }); await settle();
    send("tool_call", { toolName: "write_file", detail: "a.ts" });
    send("tool_result", { status: "success", detail: "written" });
    send("narration", { text: "after write" });
    send("agent_loop_complete", { detail: "done" }); await settle();
    const kinds = state.transcript.map(e => e.kind);
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("narration"));
    expect(state.liveTail.streamingAnswer).toBe("");
  });

  it.each(["write_file", "read_file"])("retains child attribution for buffered %s results", async (toolName) => {
    send("subagent_started", { subagentId: "child", subagentType: "worker" });
    send("tool_call", { toolName, detail: "child.ts" });
    send("tool_result", { status: "success", detail: "child result" });
    if (toolName === "read_file") await settle();
    send("subagent_completed", { subagentId: "child", status: "success" });
    send("tool_call", { toolName: "write_file", detail: "parent.ts" });
    await settle();
    const child = state.transcript.find(e => e.kind === "tool_call" || e.kind === "tool_call_group");
    expect(child).toMatchObject({ subagentId: "child" });
  });

  it("caps the first large fragment and many small fragments without idle updates", async () => {
    send("chat_chunk", { delta: "x".repeat(5000) }); await settle();
    expect(state.liveTail.streamingAnswer).toBe("x".repeat(2000));
    for (let i = 0; i < 100; i++) send("chat_chunk", { delta: "y" });
    await settle();
    expect(state.liveTail.streamingAnswer).toBe("x".repeat(1900) + "y".repeat(100));
    const renders = commits;
    await settle();
    expect(commits).toBe(renders);
  });

  it("records late usage for the current completed run without reopening it", async () => {
    send("agent_loop_complete", { detail: "final" }); await settle();
    scheduler.finishRun("A");
    dispatch({ type: "EXECUTION_SETTLED", runId: "A" });
    send("run_summary", { flowId: undefined, cost: { totalUsd: 0.25, iterCount: 1, cacheHitPct: 0, avgIterUsd: 0.25 } });
    await settle();
    expect(state.statusBar.costUsd).toBe(0.25);
    expect(state.execution?.open).toBe(false);
    expect(state.liveTail.streamingAnswer).toBe("");
    begin("B"); await settle();
    const cost = state.statusBar.costUsd;
    bus.emit("run_summary", { runId: "A", ts: 1, type: "run_summary", title: "old cost", cost: { totalUsd: 9, iterCount: 1, cacheHitPct: 0, avgIterUsd: 9 } });
    await settle();
    expect(state.statusBar.costUsd).toBe(cost);
    expect(state.runState).toBe("running");
  });

  it("retains the transcript entry policy while streamed previews stay transient", async () => {
    for (let flowId = 2; flowId <= 402; flowId++) {
      send("chat_chunk", { flowId, delta: "preview" });
      send("agent_loop_complete", { flowId, detail: `final ${flowId}` });
      scheduler.flushNow();
    }
    await settle();
    expect(state.transcript).toHaveLength(101);
    expect(state.transcript[0]?.kind).toBe("compact_summary");
    expect(state.transcript.at(-1)).toMatchObject({ kind: "assistant_final", text: "final 402" });
    expect(state.liveTail.streamingAnswer).toBe("");
  });

  it("ignores empty fragments and an unchanged capped preview", async () => {
    send("chat_chunk", { delta: "x".repeat(2000) }); await settle();
    const renders = commits;
    send("chat_chunk", { delta: "" });
    send("chat_chunk", { delta: "x" }); await settle();
    expect(commits).toBe(renders);
  });

  it("keeps unsupported child assistant text out of the parent preview", async () => {
    send("chat_chunk", { delta: "parent" }); await settle();
    send("chat_chunk", { subagentId: "child", delta: "child text" }); await settle();
    expect(state.liveTail.streamingAnswer).toBe("parent");
  });
});
