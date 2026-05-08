import { totalCost, type ProviderName } from "./pricing.js";
import type { UsageRecord } from "./usageTracker.js";

export interface IterUsageBreakdown {
  input_uncached: number;
  cache_write: number;
  cache_read: number;
  output: number;
}

export interface IterCostAccumulator extends IterUsageBreakdown {
  iter_count: number;
  total_cost: number;
}

export interface IterCostUpdatePayload extends IterUsageBreakdown {
  type: "iter_cost_update";
  runId: string;
  iter: number;
  totalIter: number;
  iterCost: number;
  cumulativeCost: number;
  cacheHitThisIter: number;
  cacheHitCumulative: number;
  total_input_uncached: number;
  total_cache_read: number;
  total_cache_write: number;
  total_output: number;
  iter_count: number;
}

export function emptyIterCostAccumulator(): IterCostAccumulator {
  return {
    input_uncached: 0,
    cache_write: 0,
    cache_read: 0,
    output: 0,
    iter_count: 0,
    total_cost: 0,
  };
}

function cleanNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function cacheHitRatio(input: {
  input_uncached: number;
  cache_write: number;
  cache_read: number;
}): number {
  const cacheRead = cleanNumber(input.cache_read);
  const totalInput =
    cleanNumber(input.input_uncached) +
    cleanNumber(input.cache_write) +
    cacheRead;
  return totalInput > 0 ? cacheRead / totalInput : 0;
}

export function usageRecordToBreakdown(record: UsageRecord): IterUsageBreakdown {
  return {
    input_uncached: cleanNumber(record.input_uncached),
    cache_write: cleanNumber(record.cache_write),
    cache_read: cleanNumber(record.cache_read),
    output: cleanNumber(record.output),
  };
}

export function buildIterCostUpdate(input: {
  runId: string;
  iter: number;
  totalIter: number;
  provider: ProviderName;
  model: string;
  current: IterUsageBreakdown;
  previous?: IterCostAccumulator;
}): { payload: IterCostUpdatePayload; accumulator: IterCostAccumulator } {
  const previous = input.previous ?? emptyIterCostAccumulator();
  const current = {
    input_uncached: cleanNumber(input.current.input_uncached),
    cache_write: cleanNumber(input.current.cache_write),
    cache_read: cleanNumber(input.current.cache_read),
    output: cleanNumber(input.current.output),
  };
  const iterCost = totalCost(input.provider, input.model, current);
  const accumulator: IterCostAccumulator = {
    input_uncached: previous.input_uncached + current.input_uncached,
    cache_write: previous.cache_write + current.cache_write,
    cache_read: previous.cache_read + current.cache_read,
    output: previous.output + current.output,
    iter_count: previous.iter_count + 1,
    total_cost: previous.total_cost + iterCost,
  };
  return {
    accumulator,
    payload: {
      type: "iter_cost_update",
      runId: input.runId,
      iter: input.iter,
      totalIter: input.totalIter,
      iterCost,
      cumulativeCost: accumulator.total_cost,
      cacheHitThisIter: cacheHitRatio(current),
      cacheHitCumulative: cacheHitRatio(accumulator),
      input_uncached: current.input_uncached,
      cache_write: current.cache_write,
      cache_read: current.cache_read,
      output: current.output,
      total_input_uncached: accumulator.input_uncached,
      total_cache_read: accumulator.cache_read,
      total_cache_write: accumulator.cache_write,
      total_output: accumulator.output,
      iter_count: accumulator.iter_count,
    },
  };
}

export function buildIterCostUpdateFromRecords(input: {
  runId: string;
  iter: number;
  totalIter: number;
  records: UsageRecord[];
}): { payload: IterCostUpdatePayload; accumulator: IterCostAccumulator } | null {
  const records = input.records.filter((record) => record.runId === input.runId);
  const currentRecord = records[records.length - 1];
  if (!currentRecord) return null;
  let accumulator = emptyIterCostAccumulator();
  for (let i = 0; i < records.length - 1; i += 1) {
    const record = records[i];
    const next = buildIterCostUpdate({
      runId: input.runId,
      iter: i + 1,
      totalIter: input.totalIter,
      provider: record.provider,
      model: record.model,
      current: usageRecordToBreakdown(record),
      previous: accumulator,
    });
    accumulator = next.accumulator;
  }
  return buildIterCostUpdate({
    runId: input.runId,
    iter: input.iter,
    totalIter: input.totalIter,
    provider: currentRecord.provider,
    model: currentRecord.model,
    current: usageRecordToBreakdown(currentRecord),
    previous: accumulator,
  });
}
