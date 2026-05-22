import type { RolledBackError } from "../applyRollbackFeedback.js";

/** Normalized error record. Alias of RolledBackError — same shape as buildVerificationWarningsMessage opts.errors. */
export type ParsedError = RolledBackError;

/** Core verification run metadata. Absent on skipped/no_change outcomes. */
export interface VerifyDetail {
  label: string;
  durationMs: number;
  baselineErrorCount?: number;
  postErrorCount?: number;
  /** absent=pass branch; true=regression; false=pre-existing-only */
  regressed?: boolean;
  /** absent on pass; present on fail */
  errorPreview?: string;
}

/**
 * Result of verifyAndFinalize(). Six exhaustive variants covering every
 * staging + verification outcome.
 *
 * Callers switch on `kind` to determine verificationReason and emit
 * SSE telemetry. The composer does NOT emit SSE — all side-effects
 * outside file IO live in the caller.
 */
export type VerifyOutcome =
  | { kind: "applied"; verification: VerifyDetail; filesFlushed: number }
  | { kind: "applied_with_warnings"; verification: VerifyDetail; appendix: string; errors: ParsedError[]; filesFlushed: number }
  | { kind: "rolled_back"; verification: VerifyDetail; restoredFiles: string[]; errors: ParsedError[]; appendix: string; discardedStaging: Map<string, string> }
  | { kind: "pre_existing_errors"; verification: VerifyDetail; appendix: string; filesFlushed: number }
  | { kind: "skipped"; reason: "subagent_deferred" | "no_command_for_framework" | "no_staged_files"; filesFlushed?: number }
  | { kind: "no_change" };

export interface VerifyAndFinalizeInput {
  stagingFiles: Map<string, string>;
  repoPath: string;
  framework: { language?: string; testCommand?: string; hasTests?: boolean; testFilesDetected?: boolean } | undefined;
  withStagingTempFlush: <T>(staging: Map<string, string>, body: () => Promise<T>) => Promise<T>;
  verifyMode: "warn" | "rollback";
  /** true when this loop owns staging (top-level run); false for subagent loops */
  ownsStagingFiles: boolean;
}
