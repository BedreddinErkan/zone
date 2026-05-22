import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { pruneStaleReads, emitContextPruned } from "../contextPruner.js";
import type { ProcessorConfig, ProcessorContext, ProcessorResult, HistoryProcessor } from "./types.js";

export class R2ShimProcessor implements HistoryProcessor {
  readonly config: ProcessorConfig;
  readonly name = "r2-shim";
  readonly priority = 10;

  private readonly freshIterWindow: number;
  private readonly useU1: boolean;
  private prevBlocksReplaced = 0;
  private prevPruned: ChatCompletionMessageParam[] | null = null;

  constructor(config: Extract<ProcessorConfig, { kind: "r2_shim" }>) {
    this.config = config;
    this.freshIterWindow = config.freshIterWindow ?? 2;
    this.useU1 = config.useU1CacheAwareShim !== false; // default true
  }

  process(messages: ChatCompletionMessageParam[], ctx: ProcessorContext): ProcessorResult {
    const inputLen = messages.length;
    const { pruned: freshlyPruned, stats } = pruneStaleReads(messages, this.freshIterWindow);
    emitContextPruned({ runId: ctx.runId ?? "", iter: ctx.iter, stats });

    let result: ChatCompletionMessageParam[];
    if (this.useU1 && stats.blocksReplaced > this.prevBlocksReplaced && this.prevPruned !== null) {
      // U.1 cache-aware fallback: reuse the prior pruned prefix to keep the
      // Anthropic cache breakpoint #1 stable. Only append genuinely new messages.
      const newCount = messages.length - this.prevPruned.length;
      result = newCount > 0
        ? [...this.prevPruned, ...messages.slice(-newCount)]
        : this.prevPruned;
      ctx.emit("log", "[zone-cache-r2-skip]", {
        event: "cache_r2_skip",
        runId: ctx.runId ?? null,
        iter: ctx.iter + 1,
        prevBlocks: this.prevBlocksReplaced,
        newBlocks: stats.blocksReplaced,
        newMessages: newCount,
      });
    } else {
      result = freshlyPruned;
      this.prevBlocksReplaced = stats.blocksReplaced;
      this.prevPruned = freshlyPruned;
    }

    // NOTE: branch classification uses this.prevBlocksReplaced AFTER the if/else
    // — in refresh path it was updated to stats.blocksReplaced, so the comparison
    // is always false (refresh). In fallback path it was NOT updated, so the
    // comparison is true (fallback). This matches the original inline logic exactly.
    ctx.emit("log", "[zone-r2-shim]", {
      iter: ctx.iter + 1,
      runId: ctx.runId ?? null,
      branch: stats.blocksReplaced > this.prevBlocksReplaced ? "fallback" : "refresh",
      blocksReplaced: stats.blocksReplaced,
      prevBlocksReplaced: this.prevBlocksReplaced,
      responseInputLen: inputLen,
      prunedMessagesLen: result.length,
      prevPrunedMessagesLen: this.prevPruned?.length ?? 0,
    });

    return { kind: "transformed", messages: result };
  }

  reset(): void {
    this.prevBlocksReplaced = 0;
    this.prevPruned = null;
  }
}
