import {
  emitApplyRolledBackFeedback,
  emitApplyRolledBackMarker,
  emitVerifyWarnSurfaced,
  emitAgentFinalAssessment,
} from "../loopTelemetry.js";
import { verifyAndFinalize } from "../verification/index.js";
import { didApplyPatch } from "../verification/logUtils.js";
import { deriveVerdict } from "./deriveVerdict.js";
import { deriveResultFields } from "./deriveResultFields.js";
import type { FinalizeRunInput } from "./types.js";
import type { AgentLoopResult } from "../agentLoop.js";

export async function finalizeRun(input: FinalizeRunInput): Promise<AgentLoopResult> {
  const {
    trigger, emit, toolCallLog, filesModified, stagingFiles,
    isReadOnlyMode, ownsStagingFiles, withStagingTempFlush,
    verifyMode, framework, repoPath, iterCount, costUsd, tokenUsage,
    promotedFromArchetype, promotionTrigger, promotedAtIter, onProgress, runId,
  } = input;

  // readOnly fast-paths — no verification, no verdict derivation
  if (trigger === "max_iterations_readonly") {
    emit.runBreakdownSummary();
    emit.cacheSummary();
    emit.selfValidationSummary();
    return {
      success: false,
      summary: input.finalText ?? "Max iterations reached",
      toolCallLog,
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
      terminationReason: "max_iterations",
      tokenUsage,
      costUsd,
      iterCount,
      promotedFromArchetype,
      promotionTrigger,
      promotedAtIter,
    };
  }

  if (trigger === "natural_completion" && isReadOnlyMode) {
    emit.runBreakdownSummary();
    emit.cacheSummary();
    emit.selfValidationSummary();
    return {
      success: true,
      summary: input.finalText ?? "",
      toolCallLog,
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
      terminationReason: "natural_completion",
      tokenUsage,
      costUsd,
      iterCount,
      promotedFromArchetype,
      promotionTrigger,
      promotedAtIter,
    };
  }

  // Verdict derivation (non-readOnly)
  const fwForVerdict = framework
    ? { hasTests: framework.hasTests, testFilesDetected: framework.testFilesDetected }
    : undefined;
  const patchApplied = didApplyPatch(toolCallLog);

  const verdict = deriveVerdict({
    finalText: input.finalText ?? "",
    trigger: trigger as "natural_completion" | "max_iterations",
    toolCallLog,
    filesModified: Array.from(filesModified),
    framework: fwForVerdict,
    patchApplied,
    onProgress,
  });

  // Telemetry before I/O boundary
  emit.runBreakdownSummary();
  emit.cacheSummary();
  emit.selfValidationSummary();
  if (trigger === "natural_completion") {
    emitAgentFinalAssessment({
      triggeredBy: "natural_completion",
      verificationReason: verdict.reason,
      patchValidatedByAgent: verdict.patchValidatedByAgent,
      inferredFrom: verdict.inferredFrom,
      summaryPreview: verdict.strippedText.slice(0, 200),
    });
  } else {
    emitAgentFinalAssessment({
      triggeredBy: "max_iterations",
      finalVerificationReason: verdict.reason,
      inferredFrom: verdict.inferredFrom,
      patchValidatedByAgent: verdict.patchValidatedByAgent,
    });
  }

  // Verification I/O boundary
  const outcome = await verifyAndFinalize({
    stagingFiles,
    repoPath,
    framework,
    withStagingTempFlush,
    verifyMode,
    ownsStagingFiles,
  });

  // Result field derivation
  const fields = deriveResultFields(outcome, verdict);

  // Rolled-back emission (latent naming inconsistencies preserved verbatim — Gap 12)
  if (outcome.kind === "rolled_back") {
    emitApplyRolledBackFeedback({
      site: trigger === "natural_completion" ? "natural_completion" : "max_iterations",
      label: outcome.verification.label,
      durationMs: outcome.verification.durationMs,
      baselineErrorCount: outcome.verification.baselineErrorCount,
      postErrorCount: outcome.verification.postErrorCount,
      errorCount: outcome.errors.length,
      filePathsRestored: outcome.restoredFiles,
      runId: runId ?? null,
    });
    emitApplyRolledBackMarker({
      // LATENT BUG: max_iterations site uses "max_iter" for marker but "max_iterations"
      // for feedback — inconsistency preserved verbatim; tracked as Gap 12 follow-up.
      site: trigger === "natural_completion" ? "natural_completion" : "max_iter",
      markerMessage: outcome.appendix.trimStart(),
      errors: outcome.errors,
      filePathsRestored: outcome.restoredFiles,
      runId: runId ?? null,
    });
  }

  if (outcome.kind === "applied_with_warnings") {
    emitVerifyWarnSurfaced({
      // LATENT BUG: max_iterations exit uses "token_budget_exceeded" site name —
      // preserved verbatim; tracked as Gap 12 follow-up.
      site: trigger === "natural_completion" ? "natural_completion" : "token_budget_exceeded",
      label: outcome.verification.label,
      durationMs: outcome.verification.durationMs,
      baselineErrorCount: outcome.verification.baselineErrorCount,
      postErrorCount: outcome.verification.postErrorCount,
      errorCount: outcome.errors.length,
      runId: runId ?? null,
    });
  }

  return {
    success: trigger === "natural_completion",
    summary: verdict.strippedText + fields.summaryAppendix,
    toolCallLog,
    filesModified: Array.from(filesModified),
    patchValidatedByAgent: fields.patchValidatedByAgent,
    verificationReason: fields.verificationReason,
    // LATENT BUG: max_iterations exit reports "token_budget_exceeded" even though
    // this is an iteration-cap exit, not a token overflow — preserved verbatim;
    // tracked as Gap 12 follow-up.
    terminationReason: trigger === "natural_completion" ? "natural_completion" : "token_budget_exceeded",
    tokenUsage,
    costUsd,
    iterCount,
    promotedFromArchetype,
    promotionTrigger,
    promotedAtIter,
    ...(fields.discardedStaging ? { discardedStaging: fields.discardedStaging } : {}),
  };
}
