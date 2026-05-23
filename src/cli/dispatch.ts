import { randomUUID } from "node:crypto";
import { runLlmPatchFlow, type LlmPatchFlowResult } from "../core/runLlmPatchFlow.js";
import {
  rejectPendingApprovalsForRun,
  clearTrustedCommandsForRun,
} from "../api/commandApprovals.js";
import { rejectPendingRevisionsForRun } from "../llm/revisionApprovals.js";
import { loadCliConfig, validateCliConfig, type CliConfig, type CliFlags } from "./config.js";
import { createSpinner } from "./spinner.js";
import { buildCliSink } from "./sink.js";

/** Core one-shot runner. Returns the flow result — does NOT call process.exit. */
export async function runOneShotInner(
  task: string,
  config: CliConfig,
  runId: string
): Promise<LlmPatchFlowResult> {
  const ac = new AbortController();

  const spinner = createSpinner(process.stdout.isTTY === true, config.noColor);
  const sink = buildCliSink(
    {
      verbose: config.verbose,
      quiet: config.quiet,
      noColor: config.noColor,
      isTTY: process.stdout.isTTY === true,
      autoApprove: config.autoApprove,
      noRevision: config.noRevision,
    },
    spinner
  );

  const sigintHandler = (): void => {
    rejectPendingApprovalsForRun(runId);
    rejectPendingRevisionsForRun(runId);
    clearTrustedCommandsForRun(runId);
    ac.abort();
  };
  process.once("SIGINT", sigintHandler);

  try {
    const userApiKey =
      config.provider === "openai" ? config.openaiApiKey : config.anthropicApiKey;

    const result = await runLlmPatchFlow({
      task,
      repoPath: config.repoPath,
      runId,
      onProgress: sink.onProgress,
      abortSignal: ac.signal,
      userApiKey,
      provider: config.provider,
      forceTier: config.forceTier,
      mode: "patch",
    });

    return result;
  } finally {
    process.off("SIGINT", sigintHandler);
    rejectPendingApprovalsForRun(runId);
    rejectPendingRevisionsForRun(runId);
    clearTrustedCommandsForRun(runId);
    spinner.stop();
  }
}

function printResult(result: LlmPatchFlowResult, noColor: boolean): void {
  const green = noColor ? "" : "\x1b[32m";
  const red = noColor ? "" : "\x1b[31m";
  const dim = noColor ? "" : "\x1b[2m";
  const reset = noColor ? "" : "\x1b[0m";

  if ("ok" in result && result.ok) {
    const mode = result.decisionMode ?? result.finalState ?? "done";
    process.stdout.write(`\n${green}✓${reset} ${mode}\n`);
    if (result.warnings?.length) {
      for (const w of result.warnings) {
        process.stdout.write(`${dim}  ⚠ ${w}${reset}\n`);
      }
    }
  } else {
    const reason = ("reason" in result && result.reason) ? `: ${result.reason}` : "";
    process.stdout.write(`\n${red}✗${reset} Task did not complete${reason}\n`);
  }
}

/** CLI entry-point for one-shot: loads config, validates, runs, exits. */
export async function runOneShotFromCli(
  task: string,
  flags: Partial<CliFlags>
): Promise<void> {
  const config = loadCliConfig(flags);

  try {
    validateCliConfig(config);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const runId = randomUUID();
  let result: LlmPatchFlowResult;

  try {
    result = await runOneShotInner(task, config, runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("AbortError") || msg.includes("aborted")) {
      process.stderr.write("\nAborted.\n");
      process.exit(130); // SIGINT convention
    }
    process.stderr.write(`\nerror: ${msg}\n`);
    process.exit(1);
  }

  printResult(result, config.noColor);
  const success = "ok" in result && result.ok === true;
  process.exit(success ? 0 : 1);
}
