#!/usr/bin/env -S npx tsx
/**
 * Phase L.4 sweep runner — dispatches a fixed task suite against the running
 * Zone server, collects structured results, and appends them to an append-only
 * CSV file for variance tracking (L.5 dashboard input).
 *
 * Usage:
 *   npm run sweep           — full sweep (5 dispatches)
 *   npm run sweep:dry       — config validation only, no API calls
 *   ZONE_FORCE_TIER=simple npm run sweep   — server-level tier override
 *
 * Environment:
 *   ZONE_SWEEP_API_BASE     default: http://localhost:3000
 *   ZONE_SWEEP_REPO_PATH    default: directory containing this script's parent
 *   ZONE_SWEEP_USER_ID      default: sweep-runner
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const API_BASE =
  (process.env["ZONE_SWEEP_API_BASE"] ?? "http://localhost:3000").replace(/\/+$/, "");
const REPO_PATH = process.env["ZONE_SWEEP_REPO_PATH"] ?? REPO_ROOT;
const USER_ID = process.env["ZONE_SWEEP_USER_ID"] ?? "sweep-runner";
const TASKS_PATH = path.join(__dirname, "sweep-tasks.json");

/** Maps task.project keys to local repo paths for pre-task git reset. */
const TARGET_REPOS: Record<string, string> = {
  "zone-api": REPO_PATH,
  "zone-test": "/home/bedo/zone-test",
};
const RESULTS_DIR = path.join(REPO_ROOT, "data");
const RESULTS_PATH = path.join(RESULTS_DIR, "sweep-results.csv");

interface SweepTask {
  id: string;
  tier_expected: string;
  tier_forced?: string;
  description: string;
  expected_max_cost_usd: number;
  expected_rolled_back?: boolean;
  notes?: string;
  /** Target repo key in TARGET_REPOS. Defaults to "zone-api" (REPO_PATH) when absent. */
  project?: string;
}

interface TaskClassification {
  tier: string;
  estimatedFiles: number;
  estimatedIterations: number;
  needsSubagent: boolean;
  confidence: number;
  reasoning?: string;
  classifierCostUsd: number;
  classifierLatencyMs: number;
  classifierModel: string;
  fallbackUsed?: boolean;
}

interface PatchResponse {
  ok: boolean;
  reason?: string;
  decisionMode?: string;
  costUsd?: number;
  applyPatches?: unknown[];
  fileDiffs?: Array<{ filePath: string }>;
  taskClassification?: TaskClassification;
  warnings?: string[];
}

interface SweepResult {
  timestamp: string;
  taskId: string;
  tierExpected: string;
  tierForced: string;
  tierPredicted: string;
  classificationConfidence: number;
  classifierModel: string;
  fallbackUsed: boolean;
  costUsd: number;
  durationMs: number;
  decisionMode: string;
  rolledBack: boolean;
  filesChanged: number;
  passedExpected: boolean;
  errorMessage: string;
}

const CSV_HEADERS: (keyof SweepResult)[] = [
  "timestamp",
  "taskId",
  "tierExpected",
  "tierForced",
  "tierPredicted",
  "classificationConfidence",
  "classifierModel",
  "fallbackUsed",
  "costUsd",
  "durationMs",
  "decisionMode",
  "rolledBack",
  "filesChanged",
  "passedExpected",
  "errorMessage",
];

function csvEscape(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function appendCsv(result: SweepResult): void {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
  const headerLine = CSV_HEADERS.join(",") + "\n";
  if (!fs.existsSync(RESULTS_PATH)) {
    fs.writeFileSync(RESULTS_PATH, headerLine);
  }
  const row = CSV_HEADERS.map((h) => csvEscape(result[h])).join(",");
  fs.appendFileSync(RESULTS_PATH, row + "\n");
}

function evaluateExpected(task: SweepTask, res: PatchResponse, costUsd: number): boolean {
  if (costUsd > task.expected_max_cost_usd) return false;
  const rolledBack = res.decisionMode === "rolled_back";
  if (task.expected_rolled_back !== undefined && rolledBack !== task.expected_rolled_back) {
    return false;
  }
  return true;
}

function preTaskCleanup(task: SweepTask): void {
  const repoPath = task.project ? TARGET_REPOS[task.project] : REPO_PATH;
  if (repoPath === undefined) {
    console.warn(`  ⚠ unknown project "${task.project}", skipping git reset`);
    return;
  }
  try {
    execSync("git reset --hard HEAD", { cwd: repoPath, stdio: "pipe" });
    execSync("git clean -fd", { cwd: repoPath, stdio: "pipe" });
    console.log(`  → reset ${task.project ?? "repo"} to clean HEAD`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ git reset failed: ${msg}`);
  }
}

async function dispatchTask(task: SweepTask): Promise<SweepResult> {
  const startTime = Date.now();

  const body: Record<string, unknown> = {
    task: task.description,
    repoPath: REPO_PATH,
    userId: USER_ID,
    runId: `sweep-${task.id}-${Date.now()}`,
    ...(task.tier_forced ? { forceTier: task.tier_forced } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    throw new Error(`fetch failed: ${msg}. Is the server running at ${API_BASE}?`);
  }

  const durationMs = Date.now() - startTime;

  let data: PatchResponse;
  try {
    data = (await res.json()) as PatchResponse;
  } catch {
    throw new Error(`HTTP ${res.status} — response body is not JSON`);
  }

  if (!res.ok && !data.ok) {
    const reason = data.reason ?? `HTTP ${res.status}`;
    throw new Error(reason);
  }

  const costUsd = typeof data.costUsd === "number" ? data.costUsd : 0;
  const tc = data.taskClassification;

  return {
    timestamp: new Date().toISOString(),
    taskId: task.id,
    tierExpected: task.tier_expected,
    tierForced: task.tier_forced ?? "",
    tierPredicted: tc?.tier ?? "unknown",
    classificationConfidence: tc?.confidence ?? 0,
    classifierModel: tc?.classifierModel ?? "",
    fallbackUsed: tc?.fallbackUsed ?? false,
    costUsd,
    durationMs,
    decisionMode: data.decisionMode ?? "",
    rolledBack: data.decisionMode === "rolled_back",
    filesChanged: Array.isArray(data.fileDiffs) ? data.fileDiffs.length : 0,
    passedExpected: evaluateExpected(task, data, costUsd),
    errorMessage: "",
  };
}

async function runSweep(options: { dryRun?: boolean } = {}): Promise<void> {
  if (!fs.existsSync(TASKS_PATH)) {
    throw new Error(`Tasks config not found: ${TASKS_PATH}`);
  }
  const config = JSON.parse(fs.readFileSync(TASKS_PATH, "utf8")) as {
    tasks: SweepTask[];
  };
  const tasks = config.tasks;

  console.log("=".repeat(60));
  console.log(`Zone L.4 Sweep — ${tasks.length} task(s)`);
  console.log(`  API:     ${API_BASE}`);
  console.log(`  repo:    ${REPO_PATH}`);
  console.log(`  output:  ${RESULTS_PATH}`);
  console.log(`  dry-run: ${options.dryRun ?? false}`);
  if (process.env["ZONE_FORCE_TIER"]) {
    console.log(`  ZONE_FORCE_TIER: ${process.env["ZONE_FORCE_TIER"]}`);
  }
  console.log("=".repeat(60));

  if (options.dryRun) {
    console.log("\nTasks loaded successfully:");
    for (const t of tasks) {
      const forced = t.tier_forced ? ` → forced:${t.tier_forced}` : "";
      const rollback = t.expected_rolled_back ? " [rollback expected]" : "";
      console.log(`  ✓ ${t.id}  tier:${t.tier_expected}${forced}${rollback}  max_cost:$${t.expected_max_cost_usd}`);
      if (t.notes) console.log(`    ${t.notes}`);
    }
    console.log("\nDry run complete. No dispatches sent.");
    return;
  }

  let totalCost = 0;
  let passed = 0;
  let failed = 0;

  for (const task of tasks) {
    console.log(`\n[${task.id}]`);
    console.log(`  "${task.description.slice(0, 100)}${task.description.length > 100 ? "…" : ""}"`);
    if (task.tier_forced) {
      console.log(`  note: tier_forced=${task.tier_forced} (sent as forceTier in request body)`);
    }
    preTaskCleanup(task);

    let result: SweepResult;
    try {
      result = await dispatchTask(task);
      appendCsv(result);
      totalCost += result.costUsd;

      const status = result.passedExpected ? "✓ PASS" : "✗ FAIL";
      console.log(
        `  ${status}  tier:${result.tierPredicted}(conf:${result.classificationConfidence.toFixed(2)})` +
          `  cost:$${result.costUsd.toFixed(4)}  dur:${(result.durationMs / 1000).toFixed(1)}s` +
          `  mode:${result.decisionMode}  files:${result.filesChanged}`
      );
      if (result.passedExpected) {
        passed++;
      } else {
        failed++;
        if (result.costUsd > task.expected_max_cost_usd) {
          console.log(
            `    ✗ cost $${result.costUsd.toFixed(4)} exceeds expected max $${task.expected_max_cost_usd}`
          );
        }
        if (
          task.expected_rolled_back !== undefined &&
          result.rolledBack !== task.expected_rolled_back
        ) {
          console.log(
            `    ✗ rolledBack=${result.rolledBack} expected ${task.expected_rolled_back}`
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ERROR  ${msg}`);
      const errResult: SweepResult = {
        timestamp: new Date().toISOString(),
        taskId: task.id,
        tierExpected: task.tier_expected,
        tierForced: task.tier_forced ?? "",
        tierPredicted: "error",
        classificationConfidence: 0,
        classifierModel: "",
        fallbackUsed: false,
        costUsd: 0,
        durationMs: 0,
        decisionMode: "error",
        rolledBack: false,
        filesChanged: 0,
        passedExpected: false,
        errorMessage: msg.slice(0, 300),
      };
      appendCsv(errResult);
      failed++;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Summary: ${passed}/${tasks.length} passed, ${failed} failed`);
  console.log(`Total cost: $${totalCost.toFixed(4)}`);
  console.log(`Results appended to: ${RESULTS_PATH}`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

const dryRun = process.argv.includes("--dry-run");
runSweep({ dryRun }).catch((err) => {
  console.error("Sweep failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
