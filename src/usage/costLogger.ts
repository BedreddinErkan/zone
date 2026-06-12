import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IterCostUpdatePayload } from "./iterCostMeter.js";

function costLogDir(): string {
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
      }) + "\n",
      "utf8",
    );
  } catch {
    // fail-soft: never break a run
  }
}

export function appendRunSummary(logPath: string, p: IterCostUpdatePayload): void {
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
      }) + "\n",
      "utf8",
    );
  } catch {
    // fail-soft
  }
}
