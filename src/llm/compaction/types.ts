import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export enum TurnClass {
  VERBATIM = "verbatim",
  CANDIDATE = "candidate",
}

export interface ClassifiedTurn {
  index: number;
  class: TurnClass;
  reason: string;
}

export interface CompactionResult {
  compacted: boolean;
  reason?: "under_threshold" | "no_candidates" | "compacted"
         | "exhausted" | "summarizer_failed";
  warning?: string;
  /** Populated when compacted === true: replacement for responseInput after compaction. */
  newResponseInput?: ChatCompletionMessageParam[];
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
