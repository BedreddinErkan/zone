import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IterCostUpdatePayload } from "./iterCostMeter.js";

export function costLogDir(): string {
  return path.join(os.homedir(), ".zone", "cost-logs");
}

export function costLogPath(runId: string): string {
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
  return path.join(costLogDir(), `${ts}-${(runId || "anon").slice(0, 8)}.jsonl`);
}

export function appendIterCostRecord(logPath: string, p: IterCostUpdatePayload): void {
  if (p.iterCost === 0) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        model: p.model,
        iterIndex: p.iter,
        finalIter: p.totalIter,
        input_uncached: p.input_uncached,
        cached: p.cache_read,
        output_total: p.output,
        output_reasoning: p.output_reasoning,
        output_nonreasoning: p.output_nonreasoning,
        costUsd: p.iterCost,
        cacheHitThisIter: p.cacheHitThisIter,
        tier: p.tier,
        archetype: p.archetype,
        pipelineApplied: p.pipelineApplied,
        mode: p.mode,
        estimatedIterations: p.estimatedIterations,
        taskBlockedByBudget: p.taskBlockedByBudget,
        estimatedFiles: p.estimatedFiles,
      }) + "\n",
      "utf8",
    );
  } catch {
    // fail-soft: never break a run
  }
}

/**
 * Tool-call sink health, carried here rather than in the sink itself.
 *
 * The sink cannot report its own total failure: if every append fails there is
 * no record left to carry a drop count, so an empty `tool-calls.jsonl` would be
 * indistinguishable from a run that made no tool calls. These two counters are
 * formed in the recorder and travel a DIFFERENT writer to a DIFFERENT file, so
 * they survive exactly the failure the sink cannot report on.
 *
 * The falsifiability rule they exist for: an empty or absent tool-calls.jsonl is
 * a genuine zero only when the same runId's summary reports
 * `toolCallsAttempted: 0`. `attempted > 0` with an empty sink is a writer
 * failure, not an absence.
 */
export interface ToolCallSinkHealth {
  attempted: number;
  dropped: number;
}

export function appendRunSummary(
  logPath: string,
  p: IterCostUpdatePayload,
  toolCallHealth?: ToolCallSinkHealth,
): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        type: "run_summary",
        model: p.model,
        finalIter: p.iter_count,
        total_input_uncached: p.total_input_uncached,
        total_cached: p.total_cache_read,
        total_output: p.total_output,
        total_output_reasoning: p.total_output_reasoning,
        total_output_nonreasoning: p.total_output_nonreasoning,
        totalCostUsd: p.cumulativeCost,
        runHitRatio: p.cacheHitCumulative,
        runId: p.runId,
        toolCallsAttempted: toolCallHealth?.attempted ?? 0,
        toolCallsDropped: toolCallHealth?.dropped ?? 0,
      }) + "\n",
      "utf8",
    );
  } catch {
    // fail-soft
  }
}
