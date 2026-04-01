#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import process from "node:process";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runFeatureAgent } from "../core/runFeatureAgent.js";
import { evaluateCiResult } from "../ci/evaluateCiResult.js";

const execFileAsync = promisify(execFile);

type CliOptions = {
  task?: string;
  repo?: string;
  ci?: boolean;
  verbose?: boolean;
  diffAware?: boolean;
  output?: string;
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

function buildErrorResult(task: string, repoPath: string, message: string) {
  return {
    task,
    targetPath: repoPath,
    summary: `Run failed: ${message}`,
    decision: {
      mode: "blocked" as const,
      confidenceScore: 0,
      reason: message
    },
    confidence: {
      finalScore: 0
    },
    confidenceDetails: {
      penalties: [
        {
          label: "Runtime failure"
        }
      ]
    },
    error: {
      message,
      generatedAt: new Date().toISOString()
    }
  };
}

async function run(): Promise<void> {
  const program = new Command();

  program
    .name("smile-agent")
    .description("AI-powered code agent for practical repository change planning and patch generation.")
    .requiredOption("--task <text>", "Task or change request to analyze")
    .option("--repo <path>", "Target repository path", process.cwd())
    .option("--ci", "Enable CI mode")
    .option("--verbose", "Enable verbose logs")
    .option("--diff-aware", "Boost ranking using git diff context")
    .option("--mode <mode>", "Execution mode: preview | dry-run | apply", "preview")
    .option(
      "--output <path>",
      "Path for structured JSON result output",
      DEFAULT_RESULT_PATH
    )
    .allowExcessArguments(false)
    .parse(process.argv);

  const options = program.opts<CliOptions>();

  const task = resolveTask(options);
  const repoPath = resolveRepoPath(options);
  const resultPath = resolveResultPath(options);
  const mode = resolveMode(options);
  const ciMode = Boolean(options.ci);
  const verbose = Boolean(options.verbose);
  const diffAware = Boolean(options.diffAware);

  printHeader();
  console.log(`Mode: ${ciMode ? "CI" : "standard"}`);

  printVerbose("cli.options", options, verbose);
  printVerbose("repoPath", repoPath, verbose);
  printVerbose("resultPath", resultPath, verbose);

  try {
    const changedFiles = diffAware ? await getChangedFiles(repoPath) : [];

    if (diffAware) {
      printVerbose("changedFiles", changedFiles, verbose);
    }

    const result = await runFeatureAgent({
      task,
      targetPath: repoPath,
      mode,
      changedFiles
    });

    await writeJsonFile(resultPath, result);

    if (ciMode) {
      const ciEvaluation = evaluateCiResult(result);

      printStatusLine(ciEvaluation.statusLine);
      printSummaryLine(ciEvaluation.summaryLine);

      if (verbose) {
        printVerbose("ciEvaluation", ciEvaluation, true);
      }

      process.exit(ciEvaluation.shouldFail ? 1 : 0);
      return;
    }

    console.log(`Decision: ${result.decision.mode}`);
    console.log(`Confidence: ${result.decision.confidenceScore}`);
    console.log(`Reason: ${result.decision.reason}`);
    console.log(`Result saved: ${resultPath}`);

    process.exit(0);
  } catch (error) {
    const message = formatErrorMessage(error);
    const errorResult = buildErrorResult(task, repoPath, message);

    await writeJsonFile(resultPath, errorResult);

    if (ciMode) {
      const ciEvaluation = evaluateCiResult(errorResult);
      printStatusLine(ciEvaluation.statusLine);
      printSummaryLine(ciEvaluation.summaryLine);
      process.exit(1);
      return;
    }

    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

void run();