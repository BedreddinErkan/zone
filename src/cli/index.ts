#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import process from "node:process";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ExecutionTracker } from "../utils/executionTracker.js";
import { generateTraceId } from "../utils/trace.js";
import { runFeatureAgent } from "../core/runFeatureAgent.js";
import { runAgent } from "../core/runAgent.js";
import { loadSavedAgentResult } from "../core/loadSavedAgentResult.js";
import { evaluateCiResult } from "../ci/evaluateCiResult.js";
import type { SavedAgentResult, CliOutputFormat } from "../types/agent.js";
import { buildCliViewModel } from "../core/result/buildCliViewModel.js";
import { renderCliResult } from "../core/result/renderCliResult.js";
import { renderRunAgentResult } from "../core/renderRunAgentResult.js";
const execFileAsync = promisify(execFile);

type CliOptions = {
  task?: string;
  repo?: string;
  ci?: boolean;
  verbose?: boolean;
  diffAware?: boolean;
  output?: string;
  format?: string;
  taskOnly?: boolean;
  mode?: "preview" | "dry-run" | "apply";
};

const DEFAULT_RESULT_PATH = path.join(".agent-cache", "last-result.json");

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

async function ensureParentDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function printHeader(): void {
  console.log("Smile Agent");
}

function printStatusLine(statusLine: string): void {
  console.log(statusLine);
}

function printSummaryLine(summaryLine: string): void {
  console.log(summaryLine);
}

function printVerbose(label: string, value: unknown, enabled: boolean): void {
  if (!enabled) {
    return;
  }

  const serialized =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);

  console.log(`\n[verbose] ${label}`);
  console.log(serialized);
}

function resolveTask(options: CliOptions): string {
  const task = options.task?.trim();

  if (!task) {
    throw new Error("Missing required --task value.");
  }

  return task;
}

function resolveRepoPath(options: CliOptions): string {
  if (options.repo?.trim()) {
    return path.resolve(options.repo);
  }

  return process.cwd();
}

function resolveResultPath(options: CliOptions): string {
  if (options.output?.trim()) {
    return path.resolve(options.output);
  }

  return path.resolve(DEFAULT_RESULT_PATH);
}

function resolveMode(options: CliOptions): "preview" | "dry-run" | "apply" {
  return options.mode ?? "preview";
}

function resolveFormat(options: CliOptions): CliOutputFormat {
  switch (options.format) {
    case "summary":
    case "detailed":
    case "json":
      return options.format;
    default:
      return "summary";
  }
}

async function getChangedFiles(repoPath: string): Promise<string[]> {
  try {
    const baseSha = process.env.SMILE_AGENT_BASE_SHA?.trim();
    const headSha = process.env.SMILE_AGENT_HEAD_SHA?.trim() || "HEAD";

    const args = baseSha
      ? ["diff", "--name-only", `${baseSha}...${headSha}`]
      : ["status", "--short"];

    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      windowsHide: true
    });

    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (baseSha) {
      return lines.map((line) => line.replace(/\\/g, "/"));
    }

    return lines
      .map((line) => {
        const normalized = line.replace(/\\/g, "/");
        return normalized.length > 3 ? normalized.slice(3).trim() : normalized;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildErrorResult(
  task: string,
  repoPath: string,
  message: string
): SavedAgentResult {
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    summary: `Run failed: ${message}`,
    statusLine:
      "STATUS: BLOCKED | confidence=0 | warnings=1 | penalties=1 | patches=0 | relevant=0 | suggested=0",
    meta: {
      task,
      targetPath: repoPath,
      relevantFileCount: 0,
      suggestedFileCount: 0,
      patchCount: 0
    },
    intent: {
      rawTask: task,
      operation: "unknown",
      target: "unknown",
      scope: "unknown",
      nestedTarget: null,
      confidence: "low",
      warnings: ["Runtime failure prevented normal execution."]
    },
    schema: {
      summary: "Schema analysis unavailable due to runtime failure.",
      entities: [],
      relations: [],
      confidence: "low"
    },
    storage: {
      primaryStorage: "unknown",
      detectedClients: [],
      confidence: "low",
      reasoning: ["Runtime failure prevented storage analysis."],
      resourceStorageKind: "unknown"
    },
    validation: {
      patch: [],
      schema: []
    },
    issues: {
      summary: {
        total: 1,
        errors: 1,
        warnings: 0
      },
      grouped: [
        {
          key: "runtime",
          label: "Runtime failure",
          total: 1,
          errors: 1,
          warnings: 0,
          issues: [
            {
              code: "RUNTIME_FAILURE",
              severity: "error",
              message
            }
          ]
        }
      ],
      topRisks: [
        {
          id: "issue:runtime_failure",
          title: "Runtime failure",
          description: message,
          severity: "high",
          score: 100,
          category: "validation",
          source: "derived",
          relatedCode: "RUNTIME_FAILURE"
        }
      ]
    },
    decision: {
      mode: "blocked",
      confidence: 0,
      reason: message,
      recommendation: "Do not apply automatically. Resolve the runtime failure first."
    },
    confidenceBreakdown: {
      finalScore: 0,
      level: "low",
      factors: {
        intentClarity: 0,
        schemaCertainty: 0,
        storageCertainty: 0,
        patchValidationHealth: 0
      }
    },
    confidenceDetails: {
      baseWeightedScore: 0,
      totalPenalty: 100,
      penalties: [
        {
          code: "RUNTIME_FAILURE",
          label: "Runtime failure",
          appliedPenalty: 100
        }
      ]
    },
    notes: {
      execution: [message],
      assumptions: [],
      followUps: ["Fix the runtime failure and rerun the agent."]
    },
    debug: {
      patchTargets: [],
      suggestedFiles: []
    }
  };
}

async function runTaskOnlyFlow(options: {
  task: string;
  verbose: boolean;
  traceId: string;
  tracker: ExecutionTracker;
}): Promise<number> {
  const { task, verbose, traceId, tracker } = options;

  tracker.startPhase("run_agent");
  const result = await runAgent({ task });
  tracker.endPhase("run_agent");

  tracker.endPhase("total");

  printVerbose("runAgent.result", result, verbose);

  console.log("");
  console.log(renderRunAgentResult(result));
  console.log("");

  printVerbose(
    "execution",
    {
      traceId,
      ...tracker.build()
    },
    verbose
  );

  return 0;
}

export async function runCliWithOptions(options: CliOptions): Promise<number> {
  const tracker = new ExecutionTracker();
  const traceId = generateTraceId();

  tracker.startPhase("total");

  const task = resolveTask(options);
  const repoPath = resolveRepoPath(options);
  const resultPath = resolveResultPath(options);
  const mode = resolveMode(options);
  const format = resolveFormat(options);
  const ciMode = Boolean(options.ci);
  const verbose = Boolean(options.verbose);
  const diffAware = Boolean(options.diffAware);
  const taskOnly = Boolean(options.taskOnly);

  printHeader();
  console.log(`Mode: ${ciMode ? "CI" : "standard"}`);
  console.log(`Format: ${format}`);
  console.log(`Flow: ${taskOnly ? "task-only" : "legacy"}`);

  printVerbose("cli.options", options, verbose);
  printVerbose("repoPath", repoPath, verbose);
  printVerbose("resultPath", resultPath, verbose);

  try {
    if (taskOnly) {
      return await runTaskOnlyFlow({
        task,
        verbose,
        traceId,
        tracker
      });
    }

    const changedFiles = diffAware ? await getChangedFiles(repoPath) : [];

    if (diffAware) {
      printVerbose("changedFiles", changedFiles, verbose);
    }

    tracker.startPhase("run_agent");
    await runFeatureAgent({
      task,
      targetPath: repoPath,
      mode,
      changedFiles
    });
    tracker.endPhase("run_agent");

    tracker.startPhase("load_result");
    const savedResult = await loadSavedAgentResult(repoPath);
    tracker.endPhase("load_result");

    if (!savedResult) {
      throw new Error("Saved agent result could not be loaded after execution.");
    }

    tracker.startPhase("build_cli_view");
    const cliView = buildCliViewModel(savedResult);
    tracker.endPhase("build_cli_view");

    tracker.endPhase("total");

    savedResult.execution = {
      traceId,
      ...tracker.build()
    };

    await writeJsonFile(resultPath, savedResult);

    console.log("");
    console.log(renderCliResult(cliView, format));
    console.log("");
    console.log(`Result saved: ${resultPath}`);

    if (ciMode) {
      const ciEvaluation = evaluateCiResult(savedResult);

      printStatusLine(ciEvaluation.statusLine);
      printSummaryLine(ciEvaluation.summaryLine);

      if (verbose) {
        printVerbose("ciEvaluation", ciEvaluation, true);
      }

      return ciEvaluation.shouldFail ? 1 : 0;
    }

    return 0;
  } catch (error) {
    const message = formatErrorMessage(error);

    tracker.endPhase("total");

    if (taskOnly) {
      console.error("");
      console.error(`Task-only flow failed: ${message}`);
      console.error("");

      printVerbose(
        "execution",
        {
          traceId,
          ...tracker.build()
        },
        verbose
      );

      return 1;
    }

    const errorResult = buildErrorResult(task, repoPath, message);

    errorResult.execution = {
      traceId,
      ...tracker.build()
    };

    await writeJsonFile(resultPath, errorResult);

    if (ciMode) {
      const ciEvaluation = evaluateCiResult(errorResult);
      printStatusLine(ciEvaluation.statusLine);
      printSummaryLine(ciEvaluation.summaryLine);
      return 1;
    }

    const cliView = buildCliViewModel(errorResult);

    console.error("");
    console.error(renderCliResult(cliView, format));
    console.error("");
    console.error(`Result saved: ${resultPath}`);

    return 1;
  }
}

export async function run(): Promise<void> {
  const program = new Command();

  program
    .name("smile-agent")
    .description("AI-powered code agent for practical repository change planning and patch generation.")
    .requiredOption("--task <text>", "Task or change request to analyze")
    .option("--repo <path>", "Target repository path", process.cwd())
    .option("--ci", "Enable CI mode")
    .option("--verbose", "Enable verbose logs")
    .option("--diff-aware", "Boost ranking using git diff context")
    .option("--task-only", "Run Sprint 7 task-only orchestration flow")
    .option("--mode <mode>", "Execution mode: preview | dry-run | apply", "preview")
    .option("--format <mode>", "CLI output format: summary | detailed | json", "summary")
    .option(
      "--output <path>",
      "Path for structured JSON result output",
      DEFAULT_RESULT_PATH
    )
    .allowExcessArguments(false)
    .parse(process.argv);

  const options = program.opts<CliOptions>();
  const exitCode = await runCliWithOptions(options);
  process.exit(exitCode);
}

if (process.env.VITEST !== "true") {
  void run();
}