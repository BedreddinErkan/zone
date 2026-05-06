import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ProviderName, totalCost } from "./pricing.js";

export interface UsageRecord {
  timestamp: string;
  userId: string;
  runId: string;
  provider: ProviderName;
  model: string;
  input_uncached: number;
  cache_write: number;
  cache_read: number;
  output: number;
  est_cost_usd: number;
}

export interface UsageAggregate {
  period: "month" | "all";
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

function round4(n: number): number {
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
    })
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

export async function getUsage(
  userId: string,
  period: "month" | "all",
  options?: { storageDir?: string; now?: Date }
): Promise<UsageAggregate> {
  const all = readRecords(userId, options);
  const now = options?.now ?? new Date();
  const filtered =
    period === "month" ? all.filter((r) => isInCurrentMonth(r.timestamp, now)) : all;

  const byProvider: Record<string, { runs: number; tokens: number; costUsd: number }> = {};
  const byModel: Record<string, { runs: number; tokens: number; costUsd: number }> = {};
  let totalRuns = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;

  for (const r of filtered) {
    const tokens =
      (r.input_uncached || 0) +
      (r.cache_write || 0) +
      (r.cache_read || 0) +
      (r.output || 0);
    const cost = r.est_cost_usd || 0;
    totalRuns += 1;
    totalTokens += tokens;
    totalCostUsd += cost;

    const p = byProvider[r.provider] ?? { runs: 0, tokens: 0, costUsd: 0 };
    p.runs += 1;
    p.tokens += tokens;
    p.costUsd += cost;
    byProvider[r.provider] = p;

    const m = byModel[r.model] ?? { runs: 0, tokens: 0, costUsd: 0 };
    m.runs += 1;
    m.tokens += tokens;
    m.costUsd += cost;
    byModel[r.model] = m;
  }

  for (const k of Object.keys(byProvider)) {
    byProvider[k]!.costUsd = round2(byProvider[k]!.costUsd);
  }
  for (const k of Object.keys(byModel)) {
    byModel[k]!.costUsd = round2(byModel[k]!.costUsd);
  }

  return {
    period,
    totalRuns,
    totalTokens,
    totalCostUsd: round2(totalCostUsd),
    byProvider,
    byModel,
  };
}
