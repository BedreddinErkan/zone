import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runLlmPatchFlow, type LlmPatchFlowResult } from "../core/runLlmPatchFlow.js";
import {
  rejectPendingApprovalsForRun,
  clearTrustedCommandsForRun,
  setTrustAllForRun,
} from "../api/commandApprovals.js";
import { rejectPendingRevisionsForRun } from "../llm/revisionApprovals.js";
import { requestPlanApproval, rejectPendingPlansForRun } from "../llm/planApprovals.js";
import type { ExecutionPlan } from "../llm/executionPlan.js";
import { loadCliConfig, validateCliConfig, type CliConfig, type CliFlags } from "./config.js";
import { loadDiskModelSync } from "../api/diskModel.js";
import { runPlanInvestigation } from "../llm/planInvestigation.js";
import { createSpinner, buildCliSink } from "./sink.js";
import type { LlmPatchProgressUpdate } from "../core/agentLifecycleEvents.js";
import { preparePlanContext } from "../core/preparePlanContext.js";
import { generateExecutionPlan } from "../llm/executionPlan.js";
import { runAuditPipeline } from "../llm/auditPipeline.js";
import { readAuditModeSetting } from "../visual/tierSettings.js";
import { withRequestContext } from "../llm/openaiContext.js";
import { applyStdoutInterception } from "./tui/stdoutShield.js";

// Phase 2a quick-plan seeding cost guard
const QUICK_PLAN_FILES = 5;
const QUICK_PLAN_FILE_CAP = 3_000;   // chars per file
const QUICK_PLAN_TOTAL_CAP = 12_000; // chars total budget

export type TuiMode = "normal" | "autoAccept" | "plan";

export interface OneShotOpts {
  conversationId?: string;
  /** When provided (TUI/REPL mode), the caller manages AbortController and SIGINT. */
  externalAc?: AbortController;
  /** Custom progress callback; when provided, the built-in sink is bypassed. */
  onProgress?: (update: LlmPatchProgressUpdate) => void;
  mode?: TuiMode;
  /** Session-memory summary from prior task in this TUI session (Phase 1 opt-in). */
  priorSessionSummary?: string;
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

  let planForExecution: ExecutionPlan | undefined;

  if (opts.mode === "plan") {
    const planUserApiKey =
      effectiveConfig.provider === "openai" ? effectiveConfig.openaiApiKey :
                                             effectiveConfig.anthropicApiKey;

    // Context for plan-gen: honors user's selected model (fixes silent-Sonnet bug).
    const planGenCtx = {
      provider: effectiveConfig.provider,
      modelOverride: { high: effectiveConfig.model, standard: effectiveConfig.model },
      effort: effectiveConfig.effort,
    };

    // Cache repoSummary + relevantFiles so feedback re-plans reuse them without re-investigation.
    let planCtxRepoSummary = "";
    let planCtxRelevantFiles: string[] = [];
    let preGeneratedPlan: ExecutionPlan | undefined;
    progressCallback({ stage: "plan_generation_started", progress: { type: "plan_generation_started", ts: Date.now(), runId, title: "Planning…" } } as unknown as LlmPatchProgressUpdate);
    try {
      const planCtx = await withRequestContext(planGenCtx, () =>
        preparePlanContext({
          task,
          repoPath: effectiveConfig.repoPath,
          userApiKey: planUserApiKey,
          provider: effectiveConfig.provider,
        })
      );
      planCtxRepoSummary = planCtx.projectSummary;
      planCtxRelevantFiles = planCtx.relevantFilePaths;

      const diskSettings = loadDiskModelSync(effectiveConfig.repoPath);
      const planDepth = diskSettings?.planDepth ?? "investigate";

      if (planDepth === "investigate") {
        // Phase 2b: bounded read-only investigation → ExecutionPlan.
        preGeneratedPlan = await withRequestContext(planGenCtx, () =>
          runPlanInvestigation({
            task,
            repoPath: effectiveConfig.repoPath,
            runId,
            relevantFiles: planCtxRelevantFiles,
            repoSummary: planCtxRepoSummary,
            userApiKey: planUserApiKey,
            provider: effectiveConfig.provider,
            abortSignal: ac.signal,
            progressCallback,
          })
        );
      } else {
        // "quick" path: seed top-5 file bodies (Option B, Phase 2a).
        let seededFileContents: string | undefined;
        {
          const candidates = planCtxRelevantFiles.slice(0, QUICK_PLAN_FILES);
          const parts: string[] = [];
          let cumChars = 0;
          for (const fp of candidates) {
            try {
              let content = await readFile(fp, "utf-8");
              if (content.length > QUICK_PLAN_FILE_CAP) content = content.slice(0, QUICK_PLAN_FILE_CAP);
              if (cumChars + content.length > QUICK_PLAN_TOTAL_CAP) break;
              parts.push(`=== ${fp} ===\n${content}`);
              cumChars += content.length;
            } catch { /* skip unreadable */ }
          }
          if (parts.length > 0) seededFileContents = parts.join("\n\n");
        }
        preGeneratedPlan = await withRequestContext(planGenCtx, () =>
          generateExecutionPlan({
            task,
            repoSummary: planCtxRepoSummary,
            relevantFiles: planCtxRelevantFiles,
            userApiKey: planUserApiKey,
            provider: effectiveConfig.provider,
            seededFileContents,
          })
        );
      }
    } catch (e) { console.error("[zone-plan-gen-failed]", e); }

    if (!preGeneratedPlan) {
      progressCallback({
        stage: "narration",
        progress: {
          type: "narration",
          runId,
          ts: Date.now(),
          title: "Plan generation failed",
          text: "Plan generation failed — cannot proceed in plan mode without a plan.",
        },
      });
      ac.abort();
      return { ok: false as const, reason: "plan_gen_failed" } as unknown as LlmPatchFlowResult;
    }

    if (process.env["ZONE_PLAN_LEGACY_AUDIT"] === "1") {
      // Legacy escape hatch: old forced-audit + PlanModal A/R path.
      const auditResult = await runAuditPipeline({
        task,
        repoPath: effectiveConfig.repoPath,
        runId,
        tier: "medium",
        auditMode: readAuditModeSetting(),
        forceAudit: true,
        preGeneratedPlan,
        userApiKey: planUserApiKey,
        provider: effectiveConfig.provider,
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
      // On approve: thread preGeneratedPlan so it reaches runLlmPatchFlow.
      planForExecution = preGeneratedPlan;
    } else if (preGeneratedPlan) {
      // Default: cheap requestPlanApproval loop with feedback/refine/approve_with_feedback.
      let currentPlan = preGeneratedPlan;
      let looping = true;
      while (looping) {
        const result = await requestPlanApproval({
          proposal: {
            runId,
            planId: randomUUID(),
            objective: currentPlan.objective,
            steps: currentPlan.steps,
            scopeNotes: currentPlan.scopeNotes,
          },
          emit: (evt) => progressCallback({ stage: evt.type, progress: evt } as unknown as LlmPatchProgressUpdate),
          abortSignal: ac.signal,
          autoApprove: effectiveConfig.autoApprove,
        });
        switch (result.decision) {
          case "reject":
          case "timeout":
            ac.abort();
            return { ok: false as const, reason: "plan_rejected_by_user" } as unknown as LlmPatchFlowResult;
          case "feedback":
          case "refine":
            progressCallback({ stage: "plan_generation_started", progress: { type: "plan_generation_started", ts: Date.now(), runId, title: "Replanning…" } } as unknown as LlmPatchProgressUpdate);
            try {
              currentPlan = await withRequestContext(planGenCtx, () =>
                generateExecutionPlan({
                  task,
                  repoSummary: planCtxRepoSummary,
                  relevantFiles: planCtxRelevantFiles,
                  userApiKey: planUserApiKey,
                  provider: effectiveConfig.provider,
                  previousPlan: currentPlan,
                  userFeedback: result.feedback,
                })
              );
            } catch (e) { console.error("[zone-plan-replan-failed]", e); }
            continue;
          case "approve_with_feedback":
            progressCallback({ stage: "plan_generation_started", progress: { type: "plan_generation_started", ts: Date.now(), runId, title: "Replanning…" } } as unknown as LlmPatchProgressUpdate);
            try {
              currentPlan = await withRequestContext(planGenCtx, () =>
                generateExecutionPlan({
                  task,
                  repoSummary: planCtxRepoSummary,
                  relevantFiles: planCtxRelevantFiles,
                  userApiKey: planUserApiKey,
                  provider: effectiveConfig.provider,
                  previousPlan: currentPlan,
                  userFeedback: result.feedback,
                })
              );
            } catch (e) { console.error("[zone-plan-replan-failed]", e); }
            looping = false;
            break;
          case "accept_all":
            setTrustAllForRun(runId);
            looping = false;
            break;
          case "manual":
          default:
            looping = false;
        }
      }
      planForExecution = currentPlan;
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
      effectiveConfig.provider === "openai" ? effectiveConfig.openaiApiKey :
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
        preGeneratedPlan: planForExecution,
        summaryFormat: effectiveConfig.summaryFormat,
        priorSessionSummary: opts.priorSessionSummary,
        webSearchEnabled: effectiveConfig.webSearchEnabled,
      })
    );

    return result;
  } finally {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    rejectPendingApprovalsForRun(runId);
    rejectPendingRevisionsForRun(runId);
    rejectPendingPlansForRun(runId);
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
