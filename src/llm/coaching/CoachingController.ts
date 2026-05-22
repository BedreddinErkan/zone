import { debugLog, log } from "../../utils/logger.js";
import type { SelfCorrectTrigger } from "../agentLoop.js";
import type { FailureContext, CoachingDecision, CoachingControllerOpts, CoachingDeps } from "./types.js";

export class CoachingController {
  private _attempts = 0;
  private _budgetExhausted = false;

  constructor(
    private readonly _opts: CoachingControllerOpts,
    private readonly _deps: CoachingDeps
  ) {}

  get attempts(): number {
    return this._attempts;
  }

  get budgetExhausted(): boolean {
    return this._budgetExhausted;
  }

  routeFailure(ctx: FailureContext): CoachingDecision {
    const { signal } = ctx;
    if (!signal.failureDetected) return { kind: "noop" };

    // Detect repeat pattern (apply_patch only)
    let repeatPattern: { filePath: string; reason: string } | null = null;
    if (signal.failedToolName === "apply_patch") {
      repeatPattern = this._deps.detectRepeatedFailure(ctx.failureHistory, signal.failedToolFilePath);
      if (!repeatPattern) {
        for (const filePath of signal.failedFilesThisIter) {
          if (filePath === signal.failedToolFilePath) continue;
          const candidate = this._deps.detectRepeatedFailure(ctx.failureHistory, filePath);
          if (candidate) {
            repeatPattern = candidate;
            break;
          }
        }
      }
    }

    const failedFilePath = signal.failedToolName === "apply_patch" ? signal.failedToolFilePath : null;
    const pickedFromBackupSweep =
      repeatPattern !== null && repeatPattern.filePath !== signal.failedToolFilePath;

    if (this._attempts < ctx.maxAttempts) {
      this._attempts += 1;

      let routedTrigger: SelfCorrectTrigger;
      let newBudget = ctx.currentBudget;

      if (repeatPattern) {
        routedTrigger = "apply_patch_repeated_failure_same_file";
        this._opts.escalatedFiles.add(repeatPattern.filePath);
        this._opts.onProgress?.(JSON.stringify({
          event: "zone-agent-repeat-detected",
          filePath: repeatPattern.filePath,
          reason: repeatPattern.reason,
          attempts: ctx.failureHistory.get(repeatPattern.filePath)?.length ?? 0,
        }));
        if (this._opts.escalationEnabled) {
          newBudget = this._deps.maybeGrantEscalationBonus(
            ctx.currentBudget,
            this._opts.escalatedFiles.size,
            ctx.iter,
            this._opts.onProgress,
            this._opts.baseMaxIterations
          );
        }
      } else {
        routedTrigger = this._deps.classifyFailure(
          signal.failedToolName,
          signal.failedToolOutput,
          signal.failedToolError
        ) as SelfCorrectTrigger;
      }

      const routedFilePath = repeatPattern?.filePath ?? failedFilePath;
      const perFileAttempt = routedFilePath
        ? ctx.failureHistory.get(routedFilePath)?.length ?? 0
        : 0;

      const diagnostic = this._deps.buildVerifyDiagnostic({
        failedToolOutput: signal.failedToolOutput,
        filesModified: Array.from(ctx.filesModified),
        filesInRepo: Array.isArray(ctx.repoFilePaths) ? [...ctx.repoFilePaths] : [],
        framework: ctx.framework
          ? { framework: ctx.framework.framework, language: ctx.framework.language }
          : null,
        attemptCount: this._attempts,
      });

      const scopeExpansion = this._deps.maybeExpandScopeForVerifyDiagnostic(
        ctx.executionPlan ?? null,
        diagnostic,
        ctx.repoPath
      );

      let diagnosticText = diagnostic.text;
      if (scopeExpansion.expanded && scopeExpansion.addedFile) {
        diagnosticText +=
          `\n\n**Scope expanded**: \`${scopeExpansion.addedFile}\` has been added to the writable scope ` +
          `for this run because the verification parser pinned it as the failing file. Apply your patch directly.`;
        debugLog("[zone-scope-expanded]", JSON.stringify({
          runId: this._opts.runId ?? null,
          addedFile: scopeExpansion.addedFile,
          reason: scopeExpansion.reason,
          parsedFailingFile: diagnostic.parsed?.failingFile ?? null,
          parsedErrorType: diagnostic.parsed?.errorType ?? null,
          attempt: this._attempts,
        }));
      }

      const coachingText = this._deps.buildCoachingPrompt(
        routedTrigger,
        signal.failedToolOutput,
        ctx.toolCallLog,
        {
          attemptCount: perFileAttempt || this._attempts,
          filePath: routedFilePath ?? undefined,
          generatedPathDetected: diagnostic.generatedPathDetected,
          parsedFailingFile: diagnostic.parsed?.failingFile ?? null,
        }
      );

      const remaining = ctx.maxAttempts - this._attempts;

      debugLog("[zone-agent-self-correct]", JSON.stringify({
        iter: ctx.iter + 1,
        trigger: signal.failedToolName === "run_command" ? "test_failed" : signal.failedToolName,
        routedTrigger,
        selfCorrectionAttempt: this._attempts,
        maxAttempts: ctx.maxAttempts,
        filePath: routedFilePath,
        perFileAttempt,
        detectedRepeatedFailure: repeatPattern !== null,
        repeatReason: repeatPattern?.reason ?? null,
        iterationCap: ctx.currentBudget.maxIterationsForRun,
        failedFilesThisIterCount: signal.failedFilesThisIter.size,
        pickedFromBackupSweep,
        errorPreview: signal.failedToolOutput.slice(0, 200),
        willRetry: true,
        reason: "routed_coaching_prompt_injected",
      }));

      if (signal.failedToolName === "apply_patch") {
        log("[zone-apply-patch-retry]", JSON.stringify({
          event: "apply_patch_retry",
          runId: this._opts.runId ?? null,
          iter: ctx.iter + 1,
          reason: this._deps.applyPatchRetryReason(routedTrigger),
          filePath: routedFilePath ?? null,
          attemptCount: perFileAttempt || this._attempts,
        }));
      }

      if (routedTrigger === "test_failed" || routedTrigger === "tool_command_spawn_failure") {
        const parsedFailingFile = diagnostic.parsed?.failingFile ?? null;
        const modifiedFiles = Array.from(ctx.filesModified);
        const inScope = parsedFailingFile
          ? modifiedFiles.some(
              (f) =>
                f === parsedFailingFile ||
                f.endsWith("/" + parsedFailingFile) ||
                parsedFailingFile.endsWith("/" + f)
            )
          : null;
        this._deps.emitCoachingRule({
          runId: this._opts.runId ?? null,
          iter: ctx.iter + 1,
          rule: "test_failure_scope_check",
          decision: inScope === null ? "unclear" : inScope ? "in_scope" : "out_of_scope",
          parsedFailingFile,
          modifiedFiles,
        });
      }

      debugLog("[zone-agent-diagnostic]", JSON.stringify({
        attempt: this._attempts,
        failingFile: diagnostic.parsed?.failingFile ?? null,
        failingLine: diagnostic.parsed?.failingLine ?? null,
        errorType: diagnostic.parsed?.errorType ?? null,
        generatedPathDetected: diagnostic.generatedPathDetected,
        candidateCount: diagnostic.candidates.length,
        candidatesPreview: diagnostic.candidates.slice(0, 5),
      }));

      this._opts.onProgress?.(
        `[agent_loop] Failure detected (${routedTrigger}) — self-correction attempt ${this._attempts}/${ctx.maxAttempts}`
      );

      const coachingAppend =
        `\n\n[Zone coaching — attempt ${this._attempts} of ${ctx.maxAttempts}]\n` +
        diagnosticText + `\n\n` +
        coachingText +
        `\n\nRecent failure context:\n` +
        `- Tool: ${signal.failedToolName}\n` +
        `- Error preview (first 300 chars): ${signal.failedToolOutput.slice(0, 300)}\n` +
        `You have ${remaining} retry attempt${remaining === 1 ? "" : "s"} remaining. ` +
        `After that the run will halt with the current state.`;

      return {
        kind: "coach",
        coachingAppend,
        newIterationBudget: newBudget !== ctx.currentBudget ? newBudget : undefined,
        scopeExpanded: scopeExpansion.expanded && scopeExpansion.addedFile
          ? { addedFile: scopeExpansion.addedFile, reason: scopeExpansion.reason }
          : undefined,
      };
    } else {
      // Budget exhausted — let the model produce its final summary naturally.
      this._budgetExhausted = true;
      const routedTrigger: SelfCorrectTrigger = repeatPattern
        ? "apply_patch_repeated_failure_same_file"
        : this._deps.classifyFailure(
            signal.failedToolName,
            signal.failedToolOutput,
            signal.failedToolError
          ) as SelfCorrectTrigger;
      const routedFilePath = repeatPattern?.filePath ?? failedFilePath;
      const perFileAttempt = routedFilePath
        ? ctx.failureHistory.get(routedFilePath)?.length ?? 0
        : 0;

      debugLog("[zone-agent-self-correct]", JSON.stringify({
        iter: ctx.iter + 1,
        trigger: signal.failedToolName === "run_command" ? "test_failed" : signal.failedToolName,
        routedTrigger,
        selfCorrectionAttempt: this._attempts,
        maxAttempts: ctx.maxAttempts,
        filePath: routedFilePath,
        perFileAttempt,
        detectedRepeatedFailure: repeatPattern !== null,
        repeatReason: repeatPattern?.reason ?? null,
        iterationCap: ctx.currentBudget.maxIterationsForRun,
        failedFilesThisIterCount: signal.failedFilesThisIter.size,
        pickedFromBackupSweep,
        errorPreview: signal.failedToolOutput.slice(0, 200),
        willRetry: false,
        reason: "self-correction budget exhausted — allowing model to summarise",
      }));

      return { kind: "exhausted" };
    }
  }
}
