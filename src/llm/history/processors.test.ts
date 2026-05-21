import { describe, expect, it, vi } from "vitest";
import {
  type HistoryProcessor,
  type ProcessorContext,
  type ProcessorConfig,
  runProcessorPipeline,
} from "./types.js";
import { ContextOrchestrator } from "./ContextOrchestrator.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const NOOP_CONFIG: ProcessorConfig = { kind: "r2_shim" };

function makeCtx(overrides: Partial<ProcessorContext> = {}): ProcessorContext {
  return {
    iter: 0,
    runId: null,
    toolCallLog: [],
    pollingState: new Map(),
    emit: vi.fn(),
    ...overrides,
  };
}

function makeMsg(role: "user" | "assistant" | "tool", content: string): ChatCompletionMessageParam {
  if (role === "tool") {
    return { role: "tool", content, tool_call_id: "tc1" };
  }
  return { role, content } as ChatCompletionMessageParam;
}

function makePassthrough(name: string, priority: number): HistoryProcessor {
  return {
    config: NOOP_CONFIG,
    name,
    priority,
    process: () => ({ kind: "passthrough" }),
  };
}

function makeTransformer(name: string, priority: number, transform: (msgs: ChatCompletionMessageParam[]) => ChatCompletionMessageParam[]): HistoryProcessor {
  return {
    config: NOOP_CONFIG,
    name,
    priority,
    process: (msgs) => ({ kind: "transformed", messages: transform(msgs) }),
  };
}

function makeStop(name: string, priority: number, reason: string): HistoryProcessor {
  return {
    config: NOOP_CONFIG,
    name,
    priority,
    process: () => ({ kind: "stop", reason }),
  };
}

// ── runProcessorPipeline tests ────────────────────────────────────────────────

describe("runProcessorPipeline", () => {
  it("empty pipeline returns a copy of the input", () => {
    const msgs = [makeMsg("user", "hello")];
    const result = runProcessorPipeline([], msgs, makeCtx());
    expect(result.messages).toEqual(msgs);
    expect(result.messages).not.toBe(msgs); // must be a copy
    expect(result.stoppedAt).toBeNull();
    expect(result.stoppedReason).toBeNull();
  });

  it("applies processors in priority order (lower first)", () => {
    const order: string[] = [];
    const p1: HistoryProcessor = {
      config: NOOP_CONFIG, name: "p1", priority: 20,
      process: (msgs) => { order.push("p1"); return { kind: "passthrough" }; },
    };
    const p2: HistoryProcessor = {
      config: NOOP_CONFIG, name: "p2", priority: 10,
      process: (msgs) => { order.push("p2"); return { kind: "passthrough" }; },
    };
    // Register in reverse order to confirm sorting by priority, not insertion
    runProcessorPipeline([p1, p2], [], makeCtx());
    expect(order).toEqual(["p2", "p1"]);
  });

  it("FIFO tie-breaking: same priority keeps registration order", () => {
    const order: string[] = [];
    const p1: HistoryProcessor = {
      config: NOOP_CONFIG, name: "p1", priority: 10,
      process: () => { order.push("p1"); return { kind: "passthrough" }; },
    };
    const p2: HistoryProcessor = {
      config: NOOP_CONFIG, name: "p2", priority: 10,
      process: () => { order.push("p2"); return { kind: "passthrough" }; },
    };
    runProcessorPipeline([p1, p2], [], makeCtx());
    expect(order).toEqual(["p1", "p2"]);
  });

  it("passthrough does not change messages", () => {
    const msgs = [makeMsg("user", "original")];
    const result = runProcessorPipeline([makePassthrough("noop", 10)], msgs, makeCtx());
    expect(result.messages).toEqual(msgs);
  });

  it("transformed result propagates to next processor", () => {
    const addA = makeTransformer("addA", 10, (msgs) => [...msgs, makeMsg("user", "A")]);
    const addB = makeTransformer("addB", 20, (msgs) => [...msgs, makeMsg("user", "B")]);
    const result = runProcessorPipeline([addA, addB], [], makeCtx());
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ content: "A" });
    expect(result.messages[1]).toMatchObject({ content: "B" });
  });

  it("stop sentinel short-circuits — later processors do not run", () => {
    const laterRan = vi.fn();
    const stopper = makeStop("stopper", 10, "test-stop");
    const later: HistoryProcessor = {
      config: NOOP_CONFIG, name: "later", priority: 20,
      process: () => { laterRan(); return { kind: "passthrough" }; },
    };
    const result = runProcessorPipeline([stopper, later], [makeMsg("user", "x")], makeCtx());
    expect(laterRan).not.toHaveBeenCalled();
    expect(result.stoppedAt).toBe("stopper");
    expect(result.stoppedReason).toBe("test-stop");
    // messages are the state AT the time of stop (before stopper's own transform)
    expect(result.messages).toHaveLength(1);
  });

  it("stop sentinel preserves accumulated transforms from earlier processors", () => {
    const addA = makeTransformer("addA", 10, (msgs) => [...msgs, makeMsg("user", "A")]);
    const stopper = makeStop("stopper", 20, "halt");
    const result = runProcessorPipeline([addA, stopper], [], makeCtx());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ content: "A" });
    expect(result.stoppedAt).toBe("stopper");
  });
});

// ── ContextOrchestrator tests ─────────────────────────────────────────────────

describe("ContextOrchestrator", () => {
  it("empty constructor returns input unchanged", () => {
    const orch = new ContextOrchestrator([]);
    const msgs = [makeMsg("user", "hello")];
    const result = orch.assemble({
      responseInput: msgs,
      toolCallLog: [],
      iter: 0,
      runId: null,
      emit: vi.fn(),
    });
    expect(result.messages).toEqual(msgs);
    expect(result.stoppedAt).toBeNull();
  });

  it("resetForTest() calls reset() on all processors that implement it", () => {
    const resetFn = vi.fn();
    // Build orchestrator with custom processors post-construction
    const orch = new ContextOrchestrator([]);
    // Access private for testing via casting
    const anyOrch = orch as unknown as { processors: HistoryProcessor[] };
    anyOrch.processors.push({
      config: NOOP_CONFIG,
      name: "stateful",
      priority: 10,
      process: () => ({ kind: "passthrough" }),
      reset: resetFn,
    });
    orch.resetForTest();
    expect(resetFn).toHaveBeenCalledOnce();
  });
});
