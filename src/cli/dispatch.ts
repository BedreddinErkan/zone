import { randomUUID } from "node:crypto";
import { runLlmPatchFlow, type LlmPatchFlowResult } from "../core/runLlmPatchFlow.js";
import {
  rejectPendingApprovalsForRun,
  clearTrustedCommandsForRun,
} from "../api/commandApprovals.js";
import { rejectPendingRevisionsForRun } from "../llm/revisionApprovals.js";
import { loadCliConfig, validateCliConfig, type CliConfig, type CliFlags } from "./config.js";
import { createSpinner, buildCliSink } from "./sink.js";
import type { LlmPatchProgressUpdate } from "../core/agentLifecycleEvents.js";
import { preparePlanContext } from "../core/preparePlanContext.js";
import { generateExecutionPlan } from "../llm/executionPlan.js";
import { runAuditPipeline } from "../llm/auditPipeline.js";
import { readAuditModeSetting } from "../visual/tierSettings.js";
import { withRequestContext } from "../llm/openaiContext.js";
import { applyStdoutInterception } from "./tui/stdoutShield.js";

export type TuiMode = "normal" | "autoAccept" | "plan";

export interface OneShotOpts {
  conversationId?: string;
  /** When provided (TUI/REPL mode), the caller manages AbortController and SIGINT. */
  externalAc?: AbortController;
  /** Custom progress callback; when provided, the built-in sink is bypassed. */
  onProgress?: (update: LlmPatchProgressUpdate) => void;
  mode?: TuiMode;
}

/** Core one-shot runner. Returns the flow result — does NOT call process.exit. */
export async function runOneShotInner(
  task: string,
  config: CliConfig,
  runId: string,
  opts: OneShotOpts = {}
): Promise<LlmPatchFlowResult> {
  const ac = opts.externalAc ?? new AbortController();

  const effectiveConfig = opts.mode === "autoAccept"
    ? { ...config, autoApprove: true }
    : config;

  const spinner = createSpinner(process.stdout.isTTY === true, effectiveConfig.noColor);
  const sink = buildCliSink(
    {
      verbose: effectiveConfig.verbose,
      quiet: effectiveConfig.quiet,
      noColor: effectiveConfig.noColor,
      isTTY: process.stdout.isTTY === true,
      autoApprove: effectiveConfig.autoApprove,
      noRevision: effectiveConfig.noRevision,
    },
    spinner
  );
  const progressCallback = opts.onProgress ?? sink.onProgress;

  if (opts.mode === "plan") {
    const planUserApiKey =
      effectiveConfig.provider === "openai"  ? effectiveConfig.openaiApiKey  :
      effectiveConfig.provider === "gemini"  ? effectiveConfig.geminiApiKey  :
                                               effectiveConfig.anthropicApiKey;

    let preGeneratedPlan: Awaited<ReturnType<typeof generateExecutionPlan>> | undefined;
    try {
      const planCtx = await preparePlanContext({
        task,
        repoPath: effectiveConfig.repoPath,
        userApiKey: planUserApiKey,
      });
      preGeneratedPlan = await generateExecutionPlan({
        task,
        repoSummary: planCtx.projectSummary,
        relevantFiles: planCtx.relevantFilePaths,
        userApiKey: planUserApiKey,
      });
    } catch { /* plan gen failure — audit will skip gracefully */ }

    const auditResult = await runAuditPipeline({
      task,
      repoPath: effectiveConfig.repoPath,
      runId,
      tier: "medium",
      auditMode: readAuditModeSetting(),
      forceAudit: true,
      preGeneratedPlan,
      userApiKey: planUserApiKey,
      emit: (update) => progressCallback(update as unknown as LlmPatchProgressUpdate),
      abortSignal: ac.signal,
      timeoutMs: 10 * 60 * 1000,
      autoApprove: false,
      isHeadless: false,
    });

    if (auditResult.revisionDecision === "reject") {
      ac.abort();
      return { ok: false as const, reason: "plan_rejected_by_user" } as unknown as LlmPatchFlowResult;
    }
  }

  // Only register an internal SIGINT handler when caller doesn't manage AbortController.
  let sigintHandler: (() => void) | null = null;
  if (!opts.externalAc) {
    sigintHandler = (): void => {
      rejectPendingApprovalsForRun(runId);
      rejectPendingRevisionsForRun(runId);
      clearTrustedCommandsForRun(runId);
      ac.abort();
    };
    process.once("SIGINT", sigintHandler);
  }

  try {
    const userApiKey =
      effectiveConfig.provider === "openai"  ? effectiveConfig.openaiApiKey  :
      effectiveConfig.provider === "gemini"  ? effectiveConfig.geminiApiKey  :
                                               effectiveConfig.anthropicApiKey;

    const result = await withRequestContext(
      {
        provider: effectiveConfig.provider,
        modelOverride: { high: effectiveConfig.model, standard: effectiveConfig.model },
        effort: effectiveConfig.effort,
      },
      () => runLlmPatchFlow({
        task,
        repoPath: effectiveConfig.repoPath,
        runId,
        conversationId: opts.conversationId,
        onProgress: progressCallback,
        abortSignal: ac.signal,
        userApiKey,
        provider: effectiveConfig.provider,
        forceTier: effectiveConfig.forceTier,
        mode: "patch",
      })
    );

    return result;
  } finally {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    rejectPendingApprovalsForRun(runId);
    rejectPendingRevisionsForRun(runId);
    clearTrustedCommandsForRun(runId);
    spinner.stop();
  }
}

function printResult(result: LlmPatchFlowResult, noColor: boolean, quiet: boolean): void {
  if (quiet) {
    if (!("ok" in result && result.ok)) {
      const reason = ("reason" in result && result.reason) ? `: ${result.reason}` : "";
      process.stderr.write(`error: task did not complete${reason}\n`);
    } else if (result.warnings?.length) {
      for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
    }
    return;
  }

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

export interface HeadlessOpts {
  outputFormat?: "text" | "json";
}

/** CLI entry-point for headless one-shot: loads config, validates, runs, exits. */
export async function runHeadless(
  task: string,
  flags: Partial<CliFlags>,
  headlessOpts: HeadlessOpts = {}
): Promise<void> {
  const config = loadCliConfig(flags);
  const isJson = headlessOpts.outputFormat === "json";

  // Swallow [zone-*] telemetry lines in headless text mode; ZONE_VERBOSE_LOGS=1
  // reroutes them to stderr instead. JSON mode emits a single envelope — no shield needed.
  const restoreStdout = isJson ? (): void => {} : applyStdoutInterception();
  process.once("exit", restoreStdout);

  try {
    validateCliConfig(config);
  } catch (err) {
    restoreStdout();
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const runId = randomUUID();
  const startMs = Date.now();
  let result: LlmPatchFlowResult;

  try {
    if (isJson) {
      // Suppress all sink output; we'll emit a single JSON envelope at end.
      const nullSink = { onProgress: () => undefined };
      const ac = new AbortController();
      process.once("SIGINT", () => { rejectPendingApprovalsForRun(runId); rejectPendingRevisionsForRun(runId); clearTrustedCommandsForRun(runId); ac.abort(); });
      const userApiKey = config.provider === "openai" ? config.openaiApiKey : config.anthropicApiKey;
      result = await runLlmPatchFlow({ task, repoPath: config.repoPath, runId, onProgress: nullSink.onProgress, abortSignal: ac.signal, userApiKey, provider: config.provider, forceTier: config.forceTier, mode: "patch" }).finally(() => { rejectPendingApprovalsForRun(runId); rejectPendingRevisionsForRun(runId); clearTrustedCommandsForRun(runId); });
    } else {
      result = await runOneShotInner(task, config, runId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("AbortError") || msg.includes("aborted")) {
      if (isJson) process.stdout.write(JSON.stringify({ success: false, exit_code: 130, error: "aborted" }) + "\n");
      else process.stderr.write("\nAborted.\n");
      process.exit(130);
    }
    if (isJson) process.stdout.write(JSON.stringify({ success: false, exit_code: 1, error: msg }) + "\n");
    else process.stderr.write(`\nerror: ${msg}\n`);
    process.exit(1);
  }

  const success = "ok" in result && result.ok === true;

  if (isJson) {
    const envelope = {
      success,
      exit_code: success ? 0 : 1,
      cost_usd: ("costUsd" in result ? result.costUsd : null) ?? null,
      duration_ms: Date.now() - startMs,
      turn_count: ("iterCount" in result ? result.iterCount : null) ?? null,
      summary: ("decisionMode" in result ? result.decisionMode : null) ?? ("finalState" in result ? result.finalState : null) ?? null,
    };
    process.stdout.write(JSON.stringify(envelope) + "\n");
  } else {
    printResult(result, config.noColor, config.quiet);
  }

  process.exit(success ? 0 : 1);
}

/** @deprecated Use runHeadless instead. */
export const runOneShotFromCli = runHeadless;
