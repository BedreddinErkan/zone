import path from "node:path";
import { parseTscErrorPreview, buildApplyRolledBackMessage } from "../applyRollbackFeedback.js";
import { finalizeStaging, buildVerificationWarningsMessage, type StagingVerification } from "./staging.js";
import { classifyVerificationResult } from "./classify.js";
import { buildStagedDiffs } from "../../core/fileDiff.js";
import type { VerifyOutcome, VerifyDetail, VerifyAndFinalizeInput } from "./types.js";

// Pure helper: converts a StagingVerification result to a human-readable modal header.
function summarizeVerification(verification: StagingVerification): string {
  if (verification.status === "skipped") return "no verification";
  if (verification.status === "pass") return `${verification.label} ✓`;
  // fail
  if (verification.regressed === false) return "pre-existing errors only";
  const post = verification.postErrorCount ?? "?";
  const base = verification.baselineErrorCount ?? "?";
  return `⚠ ${post} new errors (baseline ${base})`;
}

export async function verifyAndFinalize(input: VerifyAndFinalizeInput): Promise<VerifyOutcome> {
  if (!input.ownsStagingFiles) {
    return { kind: "skipped", reason: "subagent_deferred" };
  }

  const finalizeResult = await finalizeStaging({
    stagingFiles: input.stagingFiles,
    repoPath: input.repoPath,
    framework: input.framework,
    withStagingTempFlush: input.withStagingTempFlush,
    verifyMode: input.verifyMode,
    onPreFlushDiffs: input.onPreFlushDiffs,
    beforeFlush: input.stagedCheckpointHandler
      ? async ({ stagingFiles, repoPath, verification }) => {
          const files = buildStagedDiffs(stagingFiles, repoPath);
          const vSummary = summarizeVerification(verification);
          const { decision, feedback } = await input.stagedCheckpointHandler!.run({
            files,
            verificationSummary: vSummary,
            trigger: input.trigger ?? "natural_completion",
          });
          if (decision === "reject") return { action: "discard" };
          if (decision === "refine") return { action: "refine", feedback };
          if (decision === "manual") {
            for (const f of files) {
              const ok = await input.stagedCheckpointHandler!.approveFile(f.path);
              if (!ok) stagingFiles.delete(path.resolve(repoPath, f.path));
            }
            return { action: "flush" };
          }
          return { action: "flush" };  // approve_all or timeout
        }
      : undefined,
  });

  // R3 checkpoint outcomes — map before the normal flush-case classification below.
  if (finalizeResult.checkpoint?.decision === "discard") {
    return { kind: "rejected" };
  }
  if (finalizeResult.checkpoint?.decision === "refine") {
    return {
      kind: "refine_requested",
      feedback: finalizeResult.checkpoint.feedback,
      discardedStaging: finalizeResult.discardedStaging ?? new Map(),
    };
  }

  const vr = finalizeResult.verification;

  // no_changes_made: all staged content matches disk — no flush occurred
  if (vr.status === "skipped" && "reason" in vr && vr.reason === "no_changes_made") {
    return { kind: "no_change" };
  }

  // other skipped reasons: no_staged_files or no_command_for_framework
  if (vr.status === "skipped") {
    const reason = vr.reason as "no_command_for_framework" | "no_staged_files";
    return { kind: "skipped", reason, filesFlushed: finalizeResult.filesFlushed };
  }

  // verification ran (pass or fail) — build VerifyDetail
  const detail: VerifyDetail = {
    label: vr.label,
    durationMs: vr.durationMs,
    baselineErrorCount: "baselineErrorCount" in vr ? vr.baselineErrorCount : undefined,
    postErrorCount: "postErrorCount" in vr ? vr.postErrorCount : undefined,
    ...(vr.status === "fail"
      ? { regressed: vr.regressed, errorPreview: vr.errorPreview }
      : {}),
  };

  if (vr.status === "pass") {
    return { kind: "applied", verification: detail, filesFlushed: finalizeResult.filesFlushed };
  }

  // vr.status === "fail"
  const { isPreExisting } = classifyVerificationResult(
    vr.postErrorCount ?? 0,
    vr.baselineErrorCount ?? 0
  );

  if (isPreExisting) {
    const appendix =
      "\n\n**Verification has pre-existing errors** (" +
      vr.label + ", " + vr.durationMs + "ms).\n" +
      "Patch was applied because it didn't add any new errors " +
      `(${vr.postErrorCount ?? "?"} errors before, ${vr.postErrorCount ?? "?"} errors after).`;
    return {
      kind: "pre_existing_errors",
      verification: detail,
      appendix,
      filesFlushed: finalizeResult.filesFlushed,
    };
  }

  // A non-zero exit with zero counted diagnostics is not a real regression
  if ((vr.postErrorCount ?? 0) === 0) {
    return { kind: "applied", verification: detail, filesFlushed: finalizeResult.filesFlushed };
  }

  const errors = parseTscErrorPreview(vr.errorPreview ?? "");

  if (input.verifyMode === "rollback") {
    const restoredFiles = finalizeResult.discardedStaging
      ? Array.from(finalizeResult.discardedStaging.keys()).map(
          (abs) => path.relative(input.repoPath, abs) || abs
        )
      : [];
    const rolledBackBody = buildApplyRolledBackMessage({
      filePath: restoredFiles.length === 1 ? (restoredFiles[0] ?? "<staged file>") : "<multiple>",
      errors,
      restoredFiles,
    });
    return {
      kind: "rolled_back",
      verification: detail,
      restoredFiles,
      errors,
      appendix: "\n\n" + rolledBackBody,
      discardedStaging: finalizeResult.discardedStaging ?? new Map(),
    };
  }

  // warn mode (default): patches on disk, surface errors
  const appendix = "\n\n" + buildVerificationWarningsMessage({
    errors,
    filesFlushed: finalizeResult.filesFlushed,
    baselineErrorCount: vr.baselineErrorCount,
    postErrorCount: vr.postErrorCount,
  });
  return {
    kind: "applied_with_warnings",
    verification: detail,
    appendix,
    errors,
    filesFlushed: finalizeResult.filesFlushed,
  };
}
