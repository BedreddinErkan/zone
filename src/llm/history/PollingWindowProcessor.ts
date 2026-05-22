import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ProcessorConfig, ProcessorContext, ProcessorResult, HistoryProcessor } from "./types.js";

const ELISION_PLACEHOLDER = "[elided by polling window]";

export class PollingWindowProcessor implements HistoryProcessor {
  readonly config: ProcessorConfig;
  readonly name = "polling-window";
  readonly priority = 30;

  private readonly everyKSteps: number;
  private readonly keepLastN: number;
  private elisionPlan: Map<string, string> | null = null;
  private lastRecomputeIter = -1;

  constructor(config: Extract<ProcessorConfig, { kind: "polling_window" }>) {
    this.config = config;
    this.everyKSteps = config.everyKSteps;
    this.keepLastN = config.keepLastN;
  }

  process(messages: ChatCompletionMessageParam[], ctx: ProcessorContext): ProcessorResult {
    const toolMessages = messages.filter(
      (m): m is ChatCompletionMessageParam & { role: "tool"; tool_call_id: string } =>
        m.role === "tool" && typeof (m as { tool_call_id?: string }).tool_call_id === "string",
    );

    if (toolMessages.length === 0) return { kind: "passthrough" };

    const needsRecompute =
      this.elisionPlan === null ||
      ctx.iter - this.lastRecomputeIter >= this.everyKSteps;

    let action: "recompute" | "reuse";
    if (needsRecompute) {
      action = "recompute";
      this.elisionPlan = new Map();
      const toElide = toolMessages.slice(0, Math.max(0, toolMessages.length - this.keepLastN));
      for (const m of toElide) {
        this.elisionPlan.set(m.tool_call_id, ELISION_PLACEHOLDER);
      }
      this.lastRecomputeIter = ctx.iter;
    } else {
      action = "reuse";
    }

    const plan = this.elisionPlan!;
    if (plan.size === 0) {
      ctx.emit("log", "[zone-polling-window]", {
        iter: ctx.iter + 1,
        action,
        elidedCount: 0,
        keptCount: toolMessages.length,
      });
      return { kind: "passthrough" };
    }

    let elidedCount = 0;
    const result = messages.map((msg) => {
      if (msg.role !== "tool") return msg;
      const id = (msg as { tool_call_id?: string }).tool_call_id;
      if (id && plan.has(id)) {
        elidedCount++;
        return { ...msg, content: plan.get(id)! };
      }
      return msg;
    });

    ctx.emit("log", "[zone-polling-window]", {
      iter: ctx.iter + 1,
      action,
      elidedCount,
      keptCount: toolMessages.length - elidedCount,
    });

    return { kind: "transformed", messages: result };
  }

  reset(): void {
    this.elisionPlan = null;
    this.lastRecomputeIter = -1;
  }
}
