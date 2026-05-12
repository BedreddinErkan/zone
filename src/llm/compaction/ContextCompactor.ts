import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMClient } from "../types.js";
import { classifyTurns } from "./classifyTurns.js";
import { summarize } from "./summarizer.js";
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

  getCompactionCount(): number {
    return this.compactionCount;
  }

  async checkAndMaybeCompact(args: {
    responseInput: ChatCompletionMessageParam[];
    toolCallLog: Array<ToolCallRecord>;
    currentUsage: number;
    effectiveCap: number;
    client?: LLMClient;
    runId?: string | undefined;
  }): Promise<CompactionResult> {
    if (args.currentUsage < args.effectiveCap * this.THRESHOLD_RATIO) {
      return { compacted: false, reason: "under_threshold" };
    }

    if (this.compactionCount >= this.MAX_COMPACTIONS) {
      throw new CompactionExhaustedError(
        "Context exhausted via compaction. Break into subtasks."
      );
    }

    const classified = classifyTurns(args.responseInput, args.toolCallLog);
    const candidates = classified.filter((c) => c.class === TurnClass.CANDIDATE);
    if (candidates.length === 0) {
      return { compacted: false, reason: "no_candidates" };
    }

    if (!args.client) {
      // No client provided — graceful degrade (used by tests without mocking).
      return { compacted: false, reason: "summarizer_failed" };
    }

    let summaryText: string;
    try {
      const output = await summarize({
        candidateTurns: candidates.map((c) => args.responseInput[c.index]),
        totalCandidates: candidates.length,
        client: args.client,
        runId: args.runId,
      });
      summaryText = output.summaryText;
    } catch {
      // Graceful degrade — parent loop continues, will hit token cap eventually.
      return { compacted: false, reason: "summarizer_failed" };
    }

    // Build newResponseInput: verbatim turns preserved in order;
    // all candidate positions replaced by ONE synthetic system turn
    // at the position of the first candidate.
    const candidateIndices = new Set(candidates.map((c) => c.index));
    const firstCandidateIdx = candidates[0].index;
    const newResponseInput: ChatCompletionMessageParam[] = [];

    for (let i = 0; i < args.responseInput.length; i++) {
      if (candidateIndices.has(i)) {
        if (i === firstCandidateIdx) {
          newResponseInput.push({
            role: "system",
            content: `[compacted_history]\n${summaryText}\n[/compacted_history]`,
          });
        }
        continue;
      }
      newResponseInput.push(args.responseInput[i]);
    }

    this.compactionCount += 1;
    const result: CompactionResult = {
      compacted: true,
      reason: "compacted",
      newResponseInput,
    };
    if (this.compactionCount === this.WARN_AT) {
      result.warning =
        "Task has compacted 3 times. Context heavily " +
        "summarized. If next steps don't converge, suggest subtasks.";
    }
    return result;
  }
}
