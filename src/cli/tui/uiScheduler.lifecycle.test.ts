import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../eventBus.js";
import { UiScheduler } from "./uiScheduler.js";
import type { ZoneStructuredProgressEvent as Event } from "../../core/agentLifecycleEvents.js";

function event(type: Event["type"], title: string, runId = "A"): Event {
  return { runId, ts: 1, type, title };
}
afterEach(() => vi.useRealTimers());

describe("scheduler lifecycle ordering", () => {
  it("queues a large incoming fragment before events produced reentrantly by its flush", () => {
    const bus = createEventBus();
    const scheduler = new UiScheduler(bus);
    const seen: string[] = [];
    bus.on("tool_result", e => {
      seen.push(e.title);
      if (e.title === "older") scheduler.enqueue(event("tool_result", "reentrant"));
    });
    bus.on("chat_chunk", () => seen.push("large text"));
    scheduler.enqueue(event("tool_result", "older"));
    scheduler.enqueue({ ...event("chat_chunk", "text"), delta: "x".repeat(5000) });
    scheduler.flushNow();
    expect(seen).toEqual(["older", "large text", "reentrant"]);
  });

  it("delivers the fixed 512-record snapshot before a synchronous priority boundary", () => {
    const bus = createEventBus();
    const scheduler = new UiScheduler(bus);
    const seen: string[] = [];
    bus.on("tool_result", e => {
      seen.push(e.title);
      // Reentrancy must neither extend this drain nor jump ahead of its boundary.
      scheduler.enqueue(event("tool_result", `reentrant ${e.title}`));
      if (e.title === "0") scheduler.enqueue(event("subagent_completed", "reentrant completion"));
    });
    bus.on("command_approval_required", e => seen.push(e.title));
    bus.on("subagent_completed", e => seen.push(e.title));
    for (let i = 0; i < 512; i++) scheduler.enqueue(event("tool_result", String(i)));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    scheduler.enqueue(event("command_approval_required", "approval"));
    expect(seen).toEqual([...Array.from({ length: 512 }, (_, i) => String(i)), "approval"]);
    // One additional public drain is bounded too, despite its listeners producing more.
    scheduler.flushNow();
    expect(seen.length).toBeLessThanOrEqual(1025);
    expect(seen.indexOf("reentrant completion")).toBeGreaterThan(seen.indexOf("approval"));
    log.mockRestore();
  });

  it("does not merge text across an intervening tool or a distinct ownership scope", () => {
    const bus = createEventBus();
    const scheduler = new UiScheduler(bus);
    const seen: Event[] = [];
    for (const type of ["chat_chunk", "tool_call"] as const) bus.on(type, e => seen.push(e));
    const chunk = { ...event("chat_chunk", "text"), delta: "a", flowId: 1, iter: 1 };
    scheduler.enqueue(chunk);
    scheduler.enqueue(event("tool_call", "tool"));
    scheduler.enqueue({ ...chunk, delta: "b" });
    scheduler.enqueue({ ...chunk, flowId: 2, delta: "c" });
    scheduler.enqueue({ ...chunk, flowId: 2, subagentId: "child", delta: "d" });
    scheduler.flushNow();
    expect(seen.map(e => e.delta ?? e.title)).toEqual(["a", "tool", "b", "c", "d"]);
  });

  it("checks run ownership during delivery and late cleanup, not just enqueue", () => {
    const bus = createEventBus();
    const scheduler = new UiScheduler(bus);
    const acA = new AbortController();
    scheduler.beginRun("A", acA.signal);
    const seen: string[] = [];
    bus.on("tool_result", e => {
      seen.push(e.title);
      if (e.title === "switch") {
        scheduler.beginRun("B", new AbortController().signal);
        scheduler.enqueue(event("tool_result", "B result", "B"));
      }
    });
    scheduler.enqueue(event("tool_result", "switch"));
    scheduler.enqueue(event("tool_result", "obsolete A"));
    scheduler.finishRun("A");
    acA.abort();
    scheduler.cancelRun("A");
    scheduler.finishRun("A");
    scheduler.flushNow();
    expect(seen).toEqual(["switch", "B result"]);
  });

  it("abort discards pending data and rejects late content while allowing usage", () => {
    const bus = createEventBus();
    const scheduler = new UiScheduler(bus);
    const ac = new AbortController();
    scheduler.beginRun("A", ac.signal);
    const seen: string[] = [];
    for (const type of ["chat_chunk", "agent_loop_complete", "run_summary"] as const) bus.on(type, e => seen.push(e.type));
    scheduler.enqueue({ ...event("chat_chunk", "pending"), delta: "partial" });
    ac.abort();
    scheduler.enqueue(event("agent_loop_complete", "late"));
    scheduler.enqueue(event("run_summary", "usage"));
    scheduler.flushNow();
    expect(seen).toEqual(["run_summary"]);
  });
});
