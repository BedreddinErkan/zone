import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ProcessorConfig, ProcessorContext, ProcessorResult, HistoryProcessor } from "./types.js";

export class BudgetReductionProcessor implements HistoryProcessor {
  readonly config: ProcessorConfig;
  readonly name = "budget-reduction";
  readonly priority = 70;

  private readonly maxCharsPerToolResult: number;

  constructor(config: Extract<ProcessorConfig, { kind: "budget_reduction" }>) {
    this.config = config;
    this.maxCharsPerToolResult = config.maxCharsPerToolResult;
  }

  process(messages: ChatCompletionMessageParam[], ctx: ProcessorContext): ProcessorResult {
    let anyTruncated = false;
    const result = messages.map((msg) => {
      if (msg.role !== "tool") return msg;
      const content = typeof msg.content === "string" ? msg.content : null;
      if (content === null || content.length <= this.maxCharsPerToolResult) return msg;

      const headChars = Math.floor(this.maxCharsPerToolResult * 0.6);
      const tailChars = this.maxCharsPerToolResult - headChars;
      const truncated =
        content.slice(0, headChars) +
        `\n[... ${content.length - headChars - tailChars} chars truncated by budget-reduction ...]\n` +
        content.slice(-tailChars);
      anyTruncated = true;
      return { ...msg, content: truncated };
    });

    if (!anyTruncated) return { kind: "passthrough" };

    ctx.emit("log", "[zone-budget-reduction]", {
      iter: ctx.iter + 1,
      maxChars: this.maxCharsPerToolResult,
    });

    return { kind: "transformed", messages: result };
  }
}
