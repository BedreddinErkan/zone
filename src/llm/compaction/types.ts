import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export enum TurnClass {
  VERBATIM = "verbatim",
  CANDIDATE = "candidate",
  PINNED = "pinned",   // stronger than VERBATIM — never summarized, surfaced in telemetry
}

export type PinReason = "audit_artifact" | "recent_failure" | "protected_tool";

export interface ClassifiedTurn {
  index: number;
  class: TurnClass;
  reason: string;
  pinReason?: PinReason;
}

export interface CompactionResult {
  compacted: boolean;
  reason?: "under_threshold" | "no_candidates" | "compacted"
         | "exhausted" | "summarizer_failed";
  warning?: string;
  /** Populated when compacted === true: replacement for responseInput after compaction. */
  newResponseInput?: ChatCompletionMessageParam[];
  // J.1/J.2 telemetry — populated when compacted === true
  pinnedStats?: {
    audit_artifact: number;
    recent_failure: number;
  };
  verbatimCount?: number;
  candidatesSummarized?: number;
  // J.3 telemetry
  manifestStats?: { entries: number; truncated: boolean };
  // J.4 telemetry
  summaryTier?: 1 | 2 | 3;
  // Compact.2: context-window token estimates (chars/4 heuristic). Populated when compacted === true.
  tokensBefore?: number;
  tokensAfter?: number;
  savedTokens?: number;
}

/**
 * Mirrors the toolCallLog entry shape in runAgentLoopScoped exactly.
 * `id` is the originating tool_call.id; used for O(1) per-call lookup in classifyTurns.
 */
export interface ToolCallRecord {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  success?: boolean;
}

export class CompactionExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionExhaustedError";
  }
}
