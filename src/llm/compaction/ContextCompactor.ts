import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { classifyTurns } from "./classifyTurns.js";
import {
  TurnClass,
  CompactionExhaustedError,
  type CompactionResult,
  type ToolCallRecord,
} from "./types.js";

export class ContextCompactor {
  private compactionCount = 0;
  private readonly MAX_COMPACTIONS = 5;
  private readonly WARN_AT = 3;
  private readonly THRESHOLD_RATIO = 0.75;

  checkAndMaybeCompact(args: {
    responseInput: ChatCompletionMessageParam[];
    toolCallLog: Array<ToolCallRecord>;
    currentUsage: number;
    effectiveCap: number;
  }): CompactionResult {
    if (args.currentUsage < args.effectiveCap * this.THRESHOLD_RATIO) {
      return { compacted: false, reason: "under_threshold" };
    }

    if (this.compactionCount >= this.MAX_COMPACTIONS) {
      throw new CompactionExhaustedError(
        "Context exhausted via compaction. Break into subtasks."
      );
    }

    const classified = classifyTurns(args.responseInput, args.toolCallLog);
    const candidates = classified.filter(
      (c) => c.class === TurnClass.CANDIDATE
    );
    if (candidates.length === 0) {
      return { compacted: false, reason: "no_candidates" };
    }

    // P.1: no-op summarizer — responseInput is not mutated.
    // P.2 replaces this stub with a real LLM summarization call.
    this.compactionCount += 1;
    const result: CompactionResult = { compacted: true, reason: "compacted" };
    if (this.compactionCount === this.WARN_AT) {
      result.warning =
        "Task has compacted 3 times. Context heavily " +
        "summarized. If next steps don't converge, suggest subtasks.";
    }
    return result;
  }
}
