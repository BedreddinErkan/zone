import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolCallRecord } from "../compaction/types.js";
import {
  type ProcessorConfig,
  type HistoryProcessor,
  type PipelineResult,
  type ProcessorContext,
  runProcessorPipeline,
} from "./types.js";
import { ManifestInjectionProcessor } from "./ManifestInjectionProcessor.js";
import { PollingWindowProcessor } from "./PollingWindowProcessor.js";
import { BudgetReductionProcessor } from "./BudgetReductionProcessor.js";

// ── buildProcessorFromConfig ──────────────────────────────────────────────────
// Factory: creates a HistoryProcessor instance from a ProcessorConfig.
// Each commit adds a new case as processors are implemented.

function buildProcessorFromConfig(config: ProcessorConfig): HistoryProcessor {
  switch (config.kind) {
    case "manifest_injection":
      return new ManifestInjectionProcessor(config);
    case "polling_window":
      return new PollingWindowProcessor(config);
    case "budget_reduction":
      return new BudgetReductionProcessor(config);
  }
}

// ── ContextOrchestrator ───────────────────────────────────────────────────────
// Manages the HistoryProcessor pipeline for one agent run. Created once before
// the for-loop; `assemble()` is called once per iteration.

export class ContextOrchestrator {
  private readonly processors: HistoryProcessor[];
  private readonly pollingState = new Map<string, unknown>();

  constructor(configs: ProcessorConfig[]) {
    this.processors = configs.map(buildProcessorFromConfig);
  }

  assemble(args: {
    responseInput: readonly ChatCompletionMessageParam[];
    toolCallLog: readonly ToolCallRecord[];
    iter: number;
    runId: string | null;
    emit: (level: "log" | "debugLog", marker: string, payload: object) => void;
  }): PipelineResult {
    const ctx: ProcessorContext = {
      iter: args.iter,
      runId: args.runId,
      toolCallLog: args.toolCallLog,
      pollingState: this.pollingState,
      emit: args.emit,
    };
    return runProcessorPipeline(this.processors, args.responseInput, ctx);
  }

  /** Resets all stateful processor instances. For test isolation only. */
  resetForTest(): void {
    for (const p of this.processors) {
      p.reset?.();
    }
    this.pollingState.clear();
  }
}

// ── buildDefaultOrchestrator ──────────────────────────────────────────────────
// Constructs the orchestrator with Zone's default processor pipeline plus any
// caller-supplied configs. Called once from agentLoop.ts before the for-loop.

export function buildDefaultOrchestrator(
  extraConfigs?: ProcessorConfig[],
): ContextOrchestrator {
  const defaultConfigs: ProcessorConfig[] = [
    { kind: "manifest_injection", maxEntries: 20 },
  ];
  if (process.env["ZONE_HISTORY_PIPELINE_POLLING"] === "1") {
    defaultConfigs.push({ kind: "polling_window", everyKSteps: 5, keepLastN: 3 });
  }
  if (process.env["ZONE_HISTORY_PIPELINE_BUDGET"] === "1") {
    defaultConfigs.push({ kind: "budget_reduction", maxCharsPerToolResult: 32000 });
  }
  return new ContextOrchestrator([...defaultConfigs, ...(extraConfigs ?? [])]);
}
