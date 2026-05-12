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
  reason?: "under_threshold" | "no_candidates" | "compacted" | "exhausted";
  warning?: string;
}

/**
 * Aligned to the existing inline toolCallLog entry shape in runAgentLoopScoped.
 * Field name is `tool` (not `toolName`) — no `rejectionReason` field.
 */
export interface ToolCallRecord {
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
