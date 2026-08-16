import type { VerifyOutcome, ParsedError } from "../verification/types.js";
import type { VerificationReason } from "../verification/verificationReason.js";
import type { VerdictResult } from "./types.js";

export interface ResultFields {
  verificationReason: VerificationReason;
  patchValidatedByAgent: boolean;
  summaryAppendix: string;
  restoredFiles?: string[];
  errors?: ParsedError[];
  discardedStaging?: Map<string, string>;
}

const SKIPPED_APPENDIX: Record<
  "subagent_deferred" | "no_command_for_framework" | "no_staged_files",
  string
> = {
  subagent_deferred: "\n[unverified: subagent run — the parent run owns final verification]",
  no_command_for_framework:
    "\n[unverified: no verification command is available for this project's framework]",
  no_staged_files: "\n[unverified: no files were staged during this run]",
};

export function deriveResultFields(outcome: VerifyOutcome, verdict: VerdictResult): ResultFields {
  switch (outcome.kind) {
    case "no_change":
      return {
        verificationReason: "no_changes_made",
        patchValidatedByAgent: false,
        summaryAppendix: "",
      };
    case "pre_existing_errors":
      return {
        verificationReason: "tests_inconclusive",
        patchValidatedByAgent: false,
        summaryAppendix: outcome.appendix,
      };
    case "rolled_back":
      return {
        verificationReason: "verification_regressed",
        patchValidatedByAgent: false,
        summaryAppendix: outcome.appendix,
        restoredFiles: outcome.restoredFiles,
        errors: outcome.errors,
        discardedStaging: outcome.discardedStaging,
      };
    case "applied_with_warnings":
      return {
        verificationReason: "verification_warnings",
        patchValidatedByAgent: false,
        summaryAppendix: outcome.appendix,
        errors: outcome.errors,
      };
    case "applied":
      return {
        verificationReason: verdict.reason,
        patchValidatedByAgent: verdict.patchValidatedByAgent,
        summaryAppendix: "",
      };
    case "skipped":
      // The model's own tag is a claim, not a check — no verification command ran for any
      // of the three skip reasons, so patchValidatedByAgent is unconditionally false here
      // (unlike "applied", where verdict.patchValidatedByAgent reflects a real check). The
      // reason itself is left as the model reported it; the appendix names why it wasn't
      // independently confirmed, mirroring the bracketed-appendix convention the three
      // overridden branches above already use.
      return {
        verificationReason: verdict.reason,
        patchValidatedByAgent: false,
        summaryAppendix: SKIPPED_APPENDIX[outcome.reason],
      };
    case "rejected":
    case "refine_requested":
      // Unreachable: these outcomes are handled in composer.ts before deriveResultFields is called.
      throw new Error(`deriveResultFields reached unexpected R3 checkpoint outcome: ${outcome.kind}`);
  }
}
