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
    case "skipped":
      return {
        verificationReason: verdict.reason,
        patchValidatedByAgent: verdict.patchValidatedByAgent,
        summaryAppendix: "",
      };
    case "rejected":
    case "refine_requested":
      // Unreachable: these outcomes are handled in composer.ts before deriveResultFields is called.
      throw new Error(`deriveResultFields reached unexpected R3 checkpoint outcome: ${outcome.kind}`);
  }
}
