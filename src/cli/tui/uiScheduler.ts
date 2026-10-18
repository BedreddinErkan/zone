import type { EventBus } from "../eventBus.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

export type Lane = "priority" | "coalesce" | "batch";
const PRIORITY_TYPES = new Set([
  "command_approval_required", "edit_approval_required", "trust_approval_required",
  "user_question_required", "plan_ready_for_approval", "staged_diffs_ready_for_approval",
  "subagent_started", "subagent_completed",
]);
const TEXT_TYPES = new Set(["chat_chunk", "narration", "chat_response"]);
const RING_BUFFER_SIZE = 512;
const BATCH_TICK_MS = 16;
const TEXT_BATCH_LIMIT = 2000;

/** Pending delivery only. Text and lifecycle records share one causal queue. */
export class UiScheduler {
  private pending: ZoneStructuredProgressEvent[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private overflowLogged = false;
  private runId: string | null = null;
  private closed = false;
  private removeAbortListener?: () => void;

  constructor(private bus: EventBus) {}

  start(): void {
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.flushNow(), BATCH_TICK_MS);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.flushNow();
    this.removeAbortListener?.();
  }

  beginRun(runId: string, signal: AbortSignal): void {
    this.removeAbortListener?.();
    this.pending = [];
    this.runId = runId;
    this.closed = false;
    const abort = () => this.cancelRun(runId);
    signal.addEventListener("abort", abort, { once: true });
    this.removeAbortListener = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  }

  isCurrentRun(runId: string): boolean { return this.runId === runId; }

  cancelRun(runId: string): void {
    if (!this.isCurrentRun(runId)) return;
    this.closed = true;
    this.pending = [];
    this.removeAbortListener?.();
  }

  finishRun(runId: string): void {
    if (!this.isCurrentRun(runId)) return;
    this.flushNow();
    // An event subscriber may have started a different execution during delivery.
    if (!this.isCurrentRun(runId)) return;
    this.closed = true;
    this.pending = [];
    this.removeAbortListener?.();
  }

  private accepts(evt: ZoneStructuredProgressEvent): boolean {
    if (this.runId === null) return true; // Standalone scheduler consumers.
    return evt.runId === this.runId && (!this.closed || evt.type === "run_summary" || evt.type === "iter_cost_update");
  }

  /** Detach a fixed snapshot: subscriber reentrancy cannot extend this drain. */
  flushNow(): void {
    if (this.draining) return;
    this.deliver(this.pending.splice(0));
  }

  private deliver(snapshot: ZoneStructuredProgressEvent[]): void {
    this.draining = true;
    try {
      for (const evt of snapshot) {
        if (this.accepts(evt)) this.bus.emit(evt.type, evt);
      }
    } finally {
      this.draining = false;
    }
  }

  enqueue(evt: ZoneStructuredProgressEvent): void {
    if (!this.accepts(evt)) return;
    const priority = PRIORITY_TYPES.has(evt.type);
    if (priority && !this.draining) {
      // At most 512 older records plus this boundary. Reentrant events follow
      // the whole detached snapshot on the next tick, never overtake it.
      this.deliver([...this.pending.splice(0), evt]);
      return;
    }
    const last = this.pending.at(-1);
    let flushText = false;
    if (TEXT_TYPES.has(evt.type)) {
      const text = evt.type === "chat_chunk" ? evt.delta ?? "" : evt.text ?? evt.delta ?? evt.title;
      if (!text) return;
      const previous = last?.type === "chat_chunk" ? last.delta ?? "" : last?.text ?? "";
      if (last && last.type === evt.type && last.runId === evt.runId &&
          last.flowId === evt.flowId && last.iter === evt.iter && last.subagentId === evt.subagentId &&
          previous.length + text.length <= TEXT_BATCH_LIMIT) {
        this.pending[this.pending.length - 1] = evt.type === "chat_chunk"
          ? { ...last, delta: previous + text } : { ...last, text: previous + text };
        return;
      }
      // Include this incoming record in the fixed snapshot before flushing:
      // events produced by its subscribers must remain after it.
      flushText = previous.length + text.length >= TEXT_BATCH_LIMIT;
      evt = evt.type === "chat_chunk" ? { ...evt, delta: text } : { ...evt, text };
    }
    if (this.pending.length === RING_BUFFER_SIZE) {
      this.pending.shift();
      if (!this.overflowLogged) {
        console.log("[zone-ui-scheduler-overflow]");
        this.overflowLogged = true;
      }
    }
    this.pending.push(evt);
    if (!this.draining && flushText) this.flushNow();
  }
}
