import type { EventBus } from "../eventBus.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";

export type Lane = "priority" | "coalesce" | "batch";

/** Events that must emit synchronously, bypassing the batch queue. */
const PRIORITY_TYPES = new Set([
  "command_approval_required",
  "edit_approval_required",
  "trust_approval_required",
  "user_question_required",
  "plan_ready_for_approval",
  "staged_diffs_ready_for_approval",
  "subagent_started",
  "subagent_completed",
]);

/** Events whose text fragments are coalesced into a single batch after 200ms of silence. */
const COALESCE_NARRATION_TYPES = new Set(["narration", "chat_response"]);
const COALESCE_STREAMING_TYPE = "chat_chunk";

const RING_BUFFER_SIZE = 512;
const BATCH_TICK_MS = 16;
const COALESCE_SILENCE_MS = 200;

function classifyLane(type: string): Lane {
  if (PRIORITY_TYPES.has(type)) return "priority";
  if (COALESCE_NARRATION_TYPES.has(type) || type === COALESCE_STREAMING_TYPE) return "coalesce";
  return "batch";
}

/**
 * Phase 4a — UI scheduler with priority lanes. Sits between the producer
 * (onProgress bridge) and the EventBus, providing:
 * - Synchronous emission for priority events (approvals, questions)
 * - Text coalescing for narration/streaming deltas (200ms silence window)
 * - 16ms batched ticking for everything else
 * - Bounded ring buffer (512) with oldest-drop overflow policy
 *
 * CRITICAL ordering rule: before emitting ANY event (priority or batch), the
 * scheduler first flushes pending coalesce buffers. This guarantees that
 * narration deltas enqueued before a tool_call always reach the bus as a
 * narration_batch before the tool_call.
 */
export class UiScheduler {
  private bus: EventBus;
  private ringBuffer: (ZoneStructuredProgressEvent | null)[];
  private ringHead = 0;
  private ringTail = 0;
  private ringCount = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private narrationText = "";
  private streamingText = "";
  private streamingKey: string | null = null;
  private overflowLogged = false;
  private started = false;

  constructor(bus: EventBus) {
    this.bus = bus;
    this.ringBuffer = new Array(RING_BUFFER_SIZE).fill(null);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.tickTimer = setInterval(() => this.tick(), BATCH_TICK_MS);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.flushNow();
  }

  /** Test hook: drain everything synchronously without timers. */
  flushNow(): void {
    this.flushCoalesce();
    this.flushBatch();
  }

  enqueue(evt: ZoneStructuredProgressEvent): void {
    const lane = classifyLane(evt.type);

    if (lane === "priority") {
      // RULE: flush coalesce buffers before priority emission
      this.flushCoalesce();
      this.bus.emit(evt.type, evt);
      return;
    }

    if (lane === "coalesce") {
      this.accumulateCoalesce(evt);
      return;
    }

    // Batch lane — enqueue into ring buffer
    if (this.ringCount >= RING_BUFFER_SIZE) {
      // Overflow: drop oldest
      this.ringHead = (this.ringHead + 1) % RING_BUFFER_SIZE;
      this.ringCount--;
      if (!this.overflowLogged) {
        console.log("[zone-ui-scheduler-overflow]");
        this.overflowLogged = true;
      }
    }
    this.ringBuffer[this.ringTail] = evt;
    this.ringTail = (this.ringTail + 1) % RING_BUFFER_SIZE;
    this.ringCount++;
  }

  private accumulateCoalesce(evt: ZoneStructuredProgressEvent): void {
    const type = evt.type;

    if (COALESCE_NARRATION_TYPES.has(type)) {
      const text = evt.text ?? evt.delta ?? evt.title ?? "";
      if (text) this.narrationText += text;
    } else if (type === COALESCE_STREAMING_TYPE) {
      const delta = evt.delta ?? "";
      const key = `${evt.runId ?? ""}:${evt.iter ?? ""}`;
      if (this.streamingKey !== key) {
        this.streamingText = delta;
        this.streamingKey = key;
      } else {
        this.streamingText += delta;
        // Cap at 2000 chars (matching STREAMING_ANSWER_TAIL_CAP)
        if (this.streamingText.length > 2000) {
          this.streamingText = this.streamingText.slice(-2000);
        }
      }
    }

    // Reset the silence timer
    if (this.coalesceTimer !== null) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = setTimeout(() => {
      this.flushCoalesce();
      // Also flush batch on coalesce silence — events queued during the
      // coalesce window should emit alongside the aggregated text.
      this.flushBatch();
    }, COALESCE_SILENCE_MS);
  }

  private flushCoalesce(): void {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }

    if (this.narrationText) {
      this.bus.emit(
        "narration" as any,
        { type: "narration_batch", text: this.narrationText } as any,
      );
      this.narrationText = "";
    }

    if (this.streamingText) {
      this.bus.emit(
        "chat_chunk" as any,
        { type: "streaming_batch", text: this.streamingText } as any,
      );
      // Intentionally NOT cleared: streaming_text must persist across flushes
      // because STREAMING_ANSWER_SET is a wholesale set, not an append.
    }
  }

  private flushBatch(): void {
    // RULE: flush coalesce buffers before batch emission
    this.flushCoalesce();

    while (this.ringCount > 0) {
      const evt = this.ringBuffer[this.ringHead]!;
      this.ringBuffer[this.ringHead] = null;
      this.ringHead = (this.ringHead + 1) % RING_BUFFER_SIZE;
      this.ringCount--;
      this.bus.emit(evt.type, evt);
    }
  }

  private tick(): void {
    this.flushBatch(); // flushBatch internally flushes coalesce first
  }
}
