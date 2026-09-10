import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UiScheduler } from "./uiScheduler.js";
import type { EventBus } from "../eventBus.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

function makeBus(): EventBus & { emitted: Array<{ type: string; event: any }> } {
  const emitted: Array<{ type: string; event: any }> = [];
  const handlers = new Map<string, Set<(evt: any) => void>>();
  return {
    emitted,
    emit(type, event) { emitted.push({ type, event }); },
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    },
    off(type, handler) { handlers.get(type)?.delete(handler); },
  };
}

function evt(type: string, extra: Record<string, any> = {}): ZoneStructuredProgressEvent {
  return { type, runId: "r1", ts: Date.now(), title: "", ...extra } as ZoneStructuredProgressEvent;
}

describe("UiScheduler", () => {
  let bus: ReturnType<typeof makeBus>;
  let scheduler: UiScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = makeBus();
    scheduler = new UiScheduler(bus);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it("priority events emit synchronously even when stopped", () => {
    scheduler.enqueue(evt("command_approval_required", { approvalId: "a1" }));
    expect(bus.emitted).toHaveLength(1);
    expect(bus.emitted[0]!.type).toBe("command_approval_required");
  });

  it("ORDERING: narration_delta before tool_call — narration_batch emits first", () => {
    scheduler.start();
    // Enqueue narration then tool_call without advancing the tick
    scheduler.enqueue(evt("narration", { text: "hello" }));
    scheduler.enqueue(evt("tool_call", { toolName: "read_file" }));
    // flushNow to force synchronous drain
    scheduler.flushNow();
    // narration_batch must come before tool_call
    expect(bus.emitted.length).toBeGreaterThanOrEqual(2);
    const types = bus.emitted.map(e => e.type);
    const narrIdx = types.indexOf("narration");
    const toolIdx = types.indexOf("tool_call");
    expect(narrIdx).toBeLessThan(toolIdx);
    // narration_batch carries aggregated text
    expect(bus.emitted[narrIdx]!.event.text).toBe("hello");
  });

  it("coalesce: 5 narration deltas → exactly one narration_batch with concatenated text", () => {
    scheduler.start();
    for (let i = 0; i < 5; i++) {
      scheduler.enqueue(evt("narration", { text: `frag${i}` }));
    }
    // Before silence window: nothing emitted
    expect(bus.emitted).toHaveLength(0);
    // Advance past 200ms coalesce window
    vi.advanceTimersByTime(250);
    const narrationBatches = bus.emitted.filter(e => e.type === "narration");
    expect(narrationBatches).toHaveLength(1);
    expect(narrationBatches[0]!.event.text).toBe("frag0frag1frag2frag3frag4");
  });

  it("batch: 100 events enqueued in one tick → 100 emits in order on next tick", () => {
    scheduler.start();
    for (let i = 0; i < 100; i++) {
      scheduler.enqueue(evt("tool_result", { detail: `result-${i}` }));
    }
    // Nothing emitted yet (waiting for tick)
    expect(bus.emitted).toHaveLength(0);
    // Advance past one 16ms tick
    vi.advanceTimersByTime(20);
    const toolResults = bus.emitted.filter(e => e.type === "tool_result");
    expect(toolResults).toHaveLength(100);
    // Order preserved
    for (let i = 0; i < 100; i++) {
      expect(toolResults[i]!.event.detail).toBe(`result-${i}`);
    }
  });

  it("overflow: 600 batch events → buffer ≤ 512, oldest dropped, marker logged once", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Don't start — tick won't fire, so queue accumulates
    for (let i = 0; i < 600; i++) {
      scheduler.enqueue(evt("tool_result", { detail: `r-${i}` }));
    }
    // Overflow marker logged exactly once
    expect(logSpy).toHaveBeenCalledWith("[zone-ui-scheduler-overflow]");
    expect(logSpy).toHaveBeenCalledTimes(1);
    // Now flush
    scheduler.flushNow();
    const results = bus.emitted.filter(e => e.type === "tool_result");
    // 512 events survive (oldest 88 dropped)
    expect(results).toHaveLength(512);
    // The surviving events are the newest 512
    expect(results[0]!.event.detail).toBe("r-88");
    expect(results[511]!.event.detail).toBe("r-599");
    logSpy.mockRestore();
  });

  it("stop() flushes remainder", () => {
    scheduler.start();
    scheduler.enqueue(evt("tool_result", { detail: "pending" }));
    scheduler.enqueue(evt("narration", { text: "unsaid" }));
    expect(bus.emitted).toHaveLength(0);
    scheduler.stop();
    // Both events flushed: narration_batch + tool_result
    expect(bus.emitted.length).toBeGreaterThanOrEqual(2);
    const types = bus.emitted.map(e => e.type);
    expect(types).toContain("narration");
    expect(types).toContain("tool_result");
  });

  it("priority flushes coalesce before emitting", () => {
    scheduler.enqueue(evt("narration", { text: "context" }));
    scheduler.enqueue(evt("user_question_required", { question: "q?" }));
    // Priority event triggers coalesce flush first
    expect(bus.emitted.length).toBe(2);
    expect(bus.emitted[0]!.type).toBe("narration"); // narration_batch first
    expect(bus.emitted[1]!.type).toBe("user_question_required"); // then priority
  });
});
