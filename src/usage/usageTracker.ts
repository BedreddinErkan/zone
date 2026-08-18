import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ProviderName, totalCost, webSearchFee } from "./pricing.js";

export interface UsageRecord {
  timestamp: string;
  userId: string;
  runId: string;
  subagentId?: string;
  subagentType?: "worker" | "explore" | "verifier";
  parentRunId?: string;
  provider: ProviderName;
  model: string;
  input_uncached: number;
  cache_write: number;
  cache_read: number;
  output: number;
  /** Flat per-search count from Anthropic usage.server_tool_use.web_search_requests. */
  webSearchRequests?: number;
  est_cost_usd: number;
  /** K.3.C3: total wall-clock duration of the run in ms. Set only on the terminal run-summary record. */
  latencyMs?: number;
  /** K.3.C3: why the run ended. Set only on the terminal run-summary record. */
  terminationReason?: string;
}

export type UsagePeriod = "day" | "week" | "month" | "all";

export interface UsageAggregate {
  period: UsagePeriod;
  totalRuns: number;
  totalTokens: number;
  totalCostUsd: number;
  byProvider: Record<string, { runs: number; tokens: number; costUsd: number }>;
  byModel: Record<string, { runs: number; tokens: number; costUsd: number }>;
}

function getStorageDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  return path.join(os.homedir(), ".zone", "usage");
}

function getStorageFile(userId: string, overrideDir?: string): string {
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9._-]/g, "_") || "local-dev";
  return path.join(getStorageDir(overrideDir), `${safeUserId}.jsonl`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export async function recordExecution(
  rec: Omit<UsageRecord, "timestamp" | "est_cost_usd">,
  options?: { storageDir?: string }
): Promise<UsageRecord> {
  const est_cost_usd = round4(
    totalCost(rec.provider, rec.model, {
      input_uncached: rec.input_uncached,
      cache_write: rec.cache_write,
      cache_read: rec.cache_read,
      output: rec.output,
    }) + webSearchFee(rec.webSearchRequests ?? 0)
  );
  const full: UsageRecord = {
    ...rec,
    timestamp: new Date().toISOString(),
    est_cost_usd,
  };
  const dir = getStorageDir(options?.storageDir);
  const file = getStorageFile(rec.userId, options?.storageDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function readRecords(
  userId: string,
  options?: { storageDir?: string }
): UsageRecord[] {
  const file = getStorageFile(userId, options?.storageDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const records: UsageRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as UsageRecord);
    } catch {
      // Skip corrupted lines rather than failing the whole read.
    }
  }
  return records;
}

function isInCurrentMonth(timestamp: string, now: Date): boolean {
  const t = new Date(timestamp);
  if (Number.isNaN(t.getTime())) return false;
  return (
    t.getUTCFullYear() === now.getUTCFullYear() &&
    t.getUTCMonth() === now.getUTCMonth()
  );
}

function isWithinLastMs(timestamp: string, now: Date, windowMs: number): boolean {
  const t = new Date(timestamp);
  if (Number.isNaN(t.getTime())) return false;
  return now.getTime() - t.getTime() <= windowMs;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function inPeriod(record: UsageRecord, period: UsagePeriod, now: Date): boolean {
  switch (period) {
    case "all":
      return true;
    case "month":
      return isInCurrentMonth(record.timestamp, now);
    case "week":
      // Rolling 7-day window — simpler than ISO week and matches user expectation
      // of "spend in the last week" rather than "spend Mon→Sun".
      return isWithinLastMs(record.timestamp, now, WEEK_MS);
    case "day":
      // Rolling 24-hour window, same reasoning as week.
      return isWithinLastMs(record.timestamp, now, DAY_MS);
  }
}

// Distinct-runId counter that treats empty runIds as their own bucket each.
// Records share a runId when the centralized client wrapper emits one record
// per LLM call inside a single agent run; counting distinct runIds keeps the
// "Runs" metric meaningful instead of counting LLM calls.
function countRuns(records: UsageRecord[]): number {
  const seen = new Set<string>();
  let nullCount = 0;
  for (const r of records) {
    if (r.runId) seen.add(r.runId);
    else nullCount += 1;
  }
  return seen.size + nullCount;
}

export async function getUsage(
  userId: string,
  period: UsagePeriod,
  options?: { storageDir?: string; now?: Date }
): Promise<UsageAggregate> {
  const all = readRecords(userId, options);
  const now = options?.now ?? new Date();
  const filtered = all.filter((r) => inPeriod(r, period, now));

  const byProvider: Record<string, { runs: number; tokens: number; costUsd: number; _runIds: Set<string>; _nullRuns: number }> = {};
  const byModel: Record<string, { runs: number; tokens: number; costUsd: number; _runIds: Set<string>; _nullRuns: number }> = {};
  let totalTokens = 0;
  let totalCostUsd = 0;

  for (const r of filtered) {
    const tokens =
      (r.input_uncached || 0) +
      (r.cache_write || 0) +
      (r.cache_read || 0) +
      (r.output || 0);
    const cost = r.est_cost_usd || 0;
    totalTokens += tokens;
    totalCostUsd += cost;

    const p = byProvider[r.provider] ?? { runs: 0, tokens: 0, costUsd: 0, _runIds: new Set<string>(), _nullRuns: 0 };
    p.tokens += tokens;
    p.costUsd += cost;
    if (r.runId) p._runIds.add(r.runId);
    else p._nullRuns += 1;
    byProvider[r.provider] = p;

    const m = byModel[r.model] ?? { runs: 0, tokens: 0, costUsd: 0, _runIds: new Set<string>(), _nullRuns: 0 };
    m.tokens += tokens;
    m.costUsd += cost;
    if (r.runId) m._runIds.add(r.runId);
    else m._nullRuns += 1;
    byModel[r.model] = m;
  }

  const cleanProvider: Record<string, { runs: number; tokens: number; costUsd: number }> = {};
  for (const k of Object.keys(byProvider)) {
    const v = byProvider[k]!;
    cleanProvider[k] = {
      runs: v._runIds.size + v._nullRuns,
      tokens: v.tokens,
      costUsd: round2(v.costUsd),
    };
  }
  const cleanModel: Record<string, { runs: number; tokens: number; costUsd: number }> = {};
  for (const k of Object.keys(byModel)) {
    const v = byModel[k]!;
    cleanModel[k] = {
      runs: v._runIds.size + v._nullRuns,
      tokens: v.tokens,
      costUsd: round2(v.costUsd),
    };
  }

  return {
    period,
    totalRuns: countRuns(filtered),
    totalTokens,
    totalCostUsd: round2(totalCostUsd),
    byProvider: cleanProvider,
    byModel: cleanModel,
  };
}

/**
 * K.3.C3: Append a zero-cost run-summary record for a completed top-level run.
 * Carries `latencyMs` and `terminationReason` without affecting cost/token totals.
 * Uses sentinel model "__run_summary__" so it does not inflate model breakdowns.
 * Best-effort — callers must not rely on this completing before returning to the user.
 */
export async function recordRunSummary(
  params: {
    userId: string;
    runId: string;
    provider: ProviderName;
    latencyMs: number;
    terminationReason: string;
  },
  options?: { storageDir?: string }
): Promise<void> {
  const record: UsageRecord = {
    timestamp: new Date().toISOString(),
    userId: params.userId,
    runId: params.runId,
    provider: params.provider,
    model: "__run_summary__",
    input_uncached: 0,
    cache_write: 0,
    cache_read: 0,
    output: 0,
    est_cost_usd: 0,
    latencyMs: params.latencyMs,
    terminationReason: params.terminationReason,
  };
  const dir = getStorageDir(options?.storageDir);
  const file = getStorageFile(params.userId, options?.storageDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Y.1.6.4: Append a zero-cost retry-sentinel record for a run that triggered
 * at least one LLM retry. Uses sentinel model "__run_retry__" so buildRunRecords
 * can detect it and set hasRetry=true without inflating cost/token totals.
 * Best-effort — callers must not rely on this completing synchronously.
 */
export async function recordRunRetry(
  params: {
    userId: string;
    runId: string;
    provider: ProviderName;
  },
  options?: { storageDir?: string }
): Promise<void> {
  const record: UsageRecord = {
    timestamp: new Date().toISOString(),
    userId: params.userId,
    runId: params.runId,
    provider: params.provider,
    model: "__run_retry__",
    input_uncached: 0,
    cache_write: 0,
    cache_read: 0,
    output: 0,
    est_cost_usd: 0,
  };
  const dir = getStorageDir(options?.storageDir);
  const file = getStorageFile(params.userId, options?.storageDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

// Per-run cost: sum of est_cost_usd across every record with this runId.
// Used by the run lifecycle event so the UI can show inline cost next to
// each completed run.
export function getRunCost(
  userId: string,
  runId: string,
  options?: { storageDir?: string }
): number {
  if (!runId) return 0;
  const records = readRecords(userId, options);
  let sum = 0;
  for (const r of records) {
    if (r.runId === runId) sum += r.est_cost_usd || 0;
  }
  return round4(sum);
}
