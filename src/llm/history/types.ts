import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolCallRecord } from "../compaction/types.js";

// ── ProcessorContext ──────────────────────────────────────────────────────────
// Read-only snapshot of run state passed to every processor each iteration.
// Processors MUST NOT mutate any field. The orchestrator constructs this once
// per iteration from agentLoop.ts state.

export interface ProcessorContext {
  iter: number;
  runId: string | null;
  toolCallLog: readonly ToolCallRecord[];
  /** Polling state — orchestrator-owned; processors read but don't mutate. */
  pollingState: ReadonlyMap<string, unknown>;
  emit: (level: "log" | "debugLog", marker: string, payload: object) => void;
}

// ── ProcessorResult ───────────────────────────────────────────────────────────
// Processors return one of three sentinels. Unlike HookResult, there is no
// "block" or "mutateResult" — processors transform arrays, not run state.

export type ProcessorResult =
  | { kind: "transformed"; messages: ChatCompletionMessageParam[] }
  | { kind: "passthrough" }
  | { kind: "stop"; reason: string };

// ── ProcessorConfig discriminated union ───────────────────────────────────────
// Each variant carries its own knobs. ContextOrchestrator creates the runtime
// instance from the config. Adding a new processor = adding a new kind variant.
// Note: cache_control is NOT here — it operates on Anthropic-format messages
// post-translation and lives in src/llm/anthropicAdapter/cacheControlHelpers.ts.

export type ProcessorConfig =
  | { kind: "r2_shim"; freshIterWindow?: number; useU1CacheAwareShim?: boolean }
  | { kind: "manifest_injection"; maxEntries?: number }
  | { kind: "polling_window"; everyKSteps: number; keepLastN: number }
  | { kind: "budget_reduction"; maxCharsPerToolResult: number };

// ── HistoryProcessor interface ────────────────────────────────────────────────

export interface HistoryProcessor {
  readonly config: ProcessorConfig;
  readonly name: string;
  /** Lower priority fires first. Ties broken FIFO (registration order). */
  readonly priority: number;
  process(messages: ChatCompletionMessageParam[], ctx: ProcessorContext): ProcessorResult;
  /** Optional reset hook — called by ContextOrchestrator.resetForTest() only. */
  reset?(): void;
}

// ── PipelineResult ────────────────────────────────────────────────────────────

export interface PipelineResult {
  messages: ChatCompletionMessageParam[];
  /** Processor name if a "stop" sentinel fired; null otherwise. */
  stoppedAt: string | null;
  stoppedReason: string | null;
}

// ── runProcessorPipeline ──────────────────────────────────────────────────────
// Applies processors in ascending priority order (stable sort, FIFO on ties).
// Sync only — Zone is on the SSE hot path, same constraint as Gap 1 hooks.

export function runProcessorPipeline(
  processors: HistoryProcessor[],
  initialMessages: readonly ChatCompletionMessageParam[],
  ctx: ProcessorContext,
): PipelineResult {
  const sorted = [...processors].sort((a, b) => a.priority - b.priority);
  let messages: ChatCompletionMessageParam[] = [...initialMessages];
  for (const p of sorted) {
    const r = p.process(messages, ctx);
    if (r.kind === "stop") {
      return { messages, stoppedAt: p.name, stoppedReason: r.reason };
    }
    if (r.kind === "transformed") {
      messages = r.messages;
    }
    // passthrough: keep messages unchanged
  }
  return { messages, stoppedAt: null, stoppedReason: null };
}
