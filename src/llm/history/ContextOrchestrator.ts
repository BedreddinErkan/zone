import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ToolCallRecord } from "../compaction/types.js";
import {
  type ProcessorConfig,
  type HistoryProcessor,
  type PipelineResult,
  type ProcessorContext,
  runProcessorPipeline,
} from "./types.js";

// ── buildProcessorFromConfig ──────────────────────────────────────────────────
// Factory: creates a HistoryProcessor instance from a ProcessorConfig.
// Each commit adds a new case as processors are implemented.

function buildProcessorFromConfig(config: ProcessorConfig): HistoryProcessor {
  switch (config.kind) {
    case "r2_shim":
    case "manifest_injection":
    case "polling_window":
    case "budget_reduction":
      // Processors are implemented in later commits (C2–C5).
      // Until then, each config maps to a no-op passthrough placeholder.
      return {
        config,
        name: config.kind,
        priority: 100,
        process: (_messages) => ({ kind: "passthrough" }),
      };
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
    // C2: { kind: "r2_shim", freshIterWindow: 2, useU1CacheAwareShim: true },
    // C3: { kind: "manifest_injection", maxEntries: 20 },
    // C5: polling_window / budget_reduction added here behind env flags
  ];
  return new ContextOrchestrator([...defaultConfigs, ...(extraConfigs ?? [])]);
}
