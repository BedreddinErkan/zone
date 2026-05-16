export type PatchTerminationOutcome = {
  reason: string;
  userFacingMessage: string;
  canResume: boolean;
  resumeHint: string | null;
};

export function getPatchUserFacingReason(input: {
  terminationReason: string;
  context?: {
    costUsd?: number;
    capUsd?: number;
    iterCount?: number;
    iterCap?: number;
  };
}): PatchTerminationOutcome {
  const { terminationReason, context = {} } = input;

  switch (terminationReason) {
    case "natural_completion":
      return {
        reason: terminationReason,
        userFacingMessage: "Run completed successfully.",
        canResume: true,
        resumeHint: null,
      };

    case "max_iterations": {
      const iterPart =
        typeof context.iterCount === "number" && typeof context.iterCap === "number"
          ? ` (${context.iterCount}/${context.iterCap})`
          : "";
      return {
        reason: terminationReason,
        userFacingMessage: `Hit max iteration limit${iterPart}. Narrow the task or split.`,
        canResume: true,
        resumeHint: "Try a more focused follow-up task",
      };
    }

    case "token_budget_exceeded":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Token budget exceeded. Consider raising ZONE_TIER_TOKEN_CAP or splitting the task.",
        canResume: true,
        resumeHint: "Raise token cap or split task",
      };

    case "daily_usd_cap_exceeded": {
      const spent =
        typeof context.costUsd === "number" ? `$${context.costUsd.toFixed(2)}` : null;
      const cap =
        typeof context.capUsd === "number" ? `$${context.capUsd.toFixed(2)}` : null;
      const budgetPart = spent && cap ? ` (${spent} of ${cap})` : "";
      return {
        reason: terminationReason,
        userFacingMessage: `Daily USD cap reached${budgetPart}. Resets at midnight UTC.`,
        canResume: true,
        resumeHint: "Raise ZONE_DAILY_USD_CAP or wait for reset",
      };
    }

    case "compaction_exhausted":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Context compaction limit reached. Break into smaller subtasks.",
        canResume: false,
        resumeHint: null,
      };

    case "loop_detected":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Detected a loop in agent actions. Halted to prevent unbounded execution.",
        canResume: false,
        resumeHint: null,
      };

    case "APPLY_ROLLED_BACK":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Patch applied but verification failed; changes rolled back.",
        canResume: true,
        resumeHint: "Address the verification failure and retry",
      };

    default:
      return {
        reason: terminationReason,
        userFacingMessage: `Run ended unexpectedly (${terminationReason}).`,
        canResume: false,
        resumeHint: null,
      };
  }
}

export function canResumeFromTerminationReason(reason: string): boolean {
  return getPatchUserFacingReason({ terminationReason: reason }).canResume;
}
