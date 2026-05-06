/**
 * Manual test for usage pricing + tracker.
 *
 * Run after building dist:
 *   npm run build
 *   node --experimental-strip-types src/usage/__tests__/runUsageManual.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pricingPath =
  process.env.ZONE_USAGE_PRICING_MODULE || "../../../dist/usage/pricing.js";
const trackerPath =
  process.env.ZONE_USAGE_TRACKER_MODULE || "../../../dist/usage/usageTracker.js";

const { costFor, totalCost } = await import(pricingPath);
const { recordExecution, readRecords, getUsage } = await import(trackerPath);

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
    (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

const checks: { label: string; pass: boolean; details?: unknown }[] = [];

// ---- pricing.costFor ----
{
  // Sonnet 4.6: input rate $3/MTok, so 1,000,000 tokens = $3.00
  const cost = costFor("anthropic", "claude-sonnet-4-6", "input_uncached", 1_000_000);
  checks.push(check("costFor sonnet input 1M = $3.00", cost === 3, { cost }));
}
{
  // Opus 4.7: cache_read $0.50/MTok, 2M tokens = $1.00
  const cost = costFor("anthropic", "claude-opus-4-7", "cache_read", 2_000_000);
  checks.push(check("costFor opus cache_read 2M = $1.00", cost === 1, { cost }));
}
{
  // Unknown model warns + returns 0
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.join(" "));
  const cost = costFor("openai", "definitely-not-a-real-model", "output", 1_000_000);
  console.warn = origWarn;
  checks.push(check(
    "costFor unknown model returns 0 + warns",
    cost === 0 && warns.some((w) => /unknown model/.test(w)),
    { cost, warnCount: warns.length }
  ));
}

// ---- pricing.totalCost ----
{
  // Sonnet 4.6 breakdown: 1M input ($3) + 100K cache_write ($0.375) +
  // 500K cache_read ($0.15) + 200K output ($3) = $6.525
  const total = totalCost("anthropic", "claude-sonnet-4-6", {
    input_uncached: 1_000_000,
    cache_write: 100_000,
    cache_read: 500_000,
    output: 200_000,
  });
  // Allow tiny float drift.
  const expected = 3 + 0.375 + 0.15 + 3;
  checks.push(check(
    "totalCost sums all 4 token types",
    Math.abs(total - expected) < 1e-9,
    { total, expected }
  ));
}

// ---- tracker.recordExecution + readRecords ----
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-usage-test-"));
const userId = "test-user-1";

try {
  const before = readRecords(userId, { storageDir: tempDir });
  await recordExecution(
    {
      userId,
      runId: "run-001",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input_uncached: 1_000_000,
      cache_write: 0,
      cache_read: 0,
      output: 100_000,
    },
    { storageDir: tempDir }
  );
  const after = readRecords(userId, { storageDir: tempDir });
  checks.push(check(
    "recordExecution appends one record",
    after.length === before.length + 1,
    { before: before.length, after: after.length }
  ));
  checks.push(check(
    "recorded est_cost_usd matches pricing (sonnet: 1M input + 100K output = $3 + $1.5 = $4.5)",
    Math.abs(after[after.length - 1].est_cost_usd - 4.5) < 1e-4,
    { est_cost_usd: after[after.length - 1].est_cost_usd }
  ));

  // ---- getUsage aggregation ----
  await recordExecution(
    {
      userId,
      runId: "run-002",
      provider: "openai",
      model: "gpt-5-codex",
      input_uncached: 500_000,
      cache_write: 0,
      cache_read: 200_000,
      output: 50_000,
    },
    { storageDir: tempDir }
  );
  await recordExecution(
    {
      userId,
      runId: "run-003",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      input_uncached: 2_000_000,
      cache_write: 0,
      cache_read: 0,
      output: 100_000,
    },
    { storageDir: tempDir }
  );

  const allUsage = await getUsage(userId, "all", { storageDir: tempDir });
  checks.push(check(
    "getUsage all-time totalRuns counts all 3 records",
    allUsage.totalRuns === 3,
    { totalRuns: allUsage.totalRuns }
  ));
  // 1.1M + 0.75M + 2.1M = 3.95M tokens
  checks.push(check(
    "getUsage all-time totalTokens sums to 3,950,000",
    allUsage.totalTokens === 3_950_000,
    { totalTokens: allUsage.totalTokens }
  ));

  // Provider breakdown sums match total
  const providerSumCost = Object.values(allUsage.byProvider).reduce(
    (s: number, p) => s + (p as { costUsd: number }).costUsd,
    0
  );
  const providerSumTokens = Object.values(allUsage.byProvider).reduce(
    (s: number, p) => s + (p as { tokens: number }).tokens,
    0
  );
  checks.push(check(
    "byProvider sums match total (tokens + cost within rounding)",
    providerSumTokens === allUsage.totalTokens &&
      Math.abs(providerSumCost - allUsage.totalCostUsd) < 0.05,
    { providerSumCost, totalCostUsd: allUsage.totalCostUsd, providerSumTokens, totalTokens: allUsage.totalTokens }
  ));

  // Model breakdown sums match total
  const modelSumTokens = Object.values(allUsage.byModel).reduce(
    (s: number, p) => s + (p as { tokens: number }).tokens,
    0
  );
  const modelSumRuns = Object.values(allUsage.byModel).reduce(
    (s: number, p) => s + (p as { runs: number }).runs,
    0
  );
  checks.push(check(
    "byModel sums match total (tokens + runs)",
    modelSumTokens === allUsage.totalTokens && modelSumRuns === allUsage.totalRuns,
    { modelSumTokens, totalTokens: allUsage.totalTokens, modelSumRuns, totalRuns: allUsage.totalRuns }
  ));

  // ---- 'month' period filtering ----
  // Forge a record dated last month by direct file append, then verify it is
  // filtered out of period=month and included in period=all.
  const file = path.join(tempDir, `${userId}.jsonl`);
  const lastMonth = new Date();
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 2);
  const oldRecord = {
    timestamp: lastMonth.toISOString(),
    userId,
    runId: "run-old",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    input_uncached: 9_000_000,
    cache_write: 0,
    cache_read: 0,
    output: 0,
    est_cost_usd: 27,
  };
  fs.appendFileSync(file, JSON.stringify(oldRecord) + "\n", "utf8");

  const monthUsage = await getUsage(userId, "month", { storageDir: tempDir });
  const allUsage2 = await getUsage(userId, "all", { storageDir: tempDir });
  checks.push(check(
    "getUsage month excludes records outside calendar month",
    monthUsage.totalRuns === 3 && allUsage2.totalRuns === 4,
    { monthRuns: monthUsage.totalRuns, allRuns: allUsage2.totalRuns }
  ));
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[usage-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exitCode = 1;
