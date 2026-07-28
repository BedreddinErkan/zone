export type PatchTerminationCategory = "success" | "warning" | "error" | "neutral";

export type PatchTerminationOutcome = {
  reason: string;
  userFacingMessage: string;
  canResume: boolean;
  resumeHint: string | null;
  category: PatchTerminationCategory;
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
        category: "success",
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
        category: "warning",
      };
    }

    case "token_budget_exceeded":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Token budget exceeded. Consider raising ZONE_TIER_TOKEN_CAP or splitting the task.",
        canResume: true,
        resumeHint: "Raise token cap or split task",
        category: "warning",
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
        category: "warning",
      };
    }

    case "compaction_exhausted":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Context compaction limit reached. Break into smaller subtasks.",
        canResume: false,
        resumeHint: null,
        category: "error",
      };

    case "loop_detected":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Detected a loop in agent actions. Halted to prevent unbounded execution.",
        canResume: false,
        resumeHint: null,
        category: "error",
      };

    case "APPLY_ROLLED_BACK":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Patch applied but verification failed; changes rolled back.",
        canResume: true,
        resumeHint: "Address the verification failure and retry",
        category: "error",
      };

    case "phase1_handoff":
      return {
        reason: terminationReason,
        userFacingMessage: "Investigation complete. Proceeding to execution phase.",
        canResume: true,
        resumeHint: null,
        category: "success",
      };

    case "revision_approval_timeout":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Audit suggested a scope revision; no approval was received within the timeout.",
        canResume: true,
        resumeHint:
          "Set autoApproveRevisions:true in your /api/patch body, or open a GET /api/run-replay/:runId SSE stream before POSTing.",
        category: "neutral",
      };

    case "revision_rejected":
      return {
        reason: terminationReason,
        userFacingMessage: "The proposed scope revision was rejected.",
        canResume: true,
        resumeHint:
          "Provide a more concrete task spec or accept the revised scope manually.",
        category: "neutral",
      };

    case "upstream_unavailable":
      return {
        reason: terminationReason,
        userFacingMessage:
          "The upstream LLM API was unavailable after retries. Try again later.",
        canResume: true,
        resumeHint: "Retry the request; the API may be temporarily degraded.",
        category: "error",
      };

    case "awaiting_user_input":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Stopped with a question outstanding. Resume to answer it and continue.",
        canResume: true,
        resumeHint: "Run `zone --resume` to see the question and reply",
        category: "neutral",
      };

    case "semantic_stall":
      return {
        reason: terminationReason,
        userFacingMessage:
          "Detected a non-progress loop. Paused to prevent wasted spend. " +
          "Retry with a narrower or different approach.",
        canResume: true,
        resumeHint: "Narrow the task or provide a different implementation hint",
        category: "warning",
      };

    default:
      return {
        reason: terminationReason,
        userFacingMessage: `Run ended unexpectedly (${terminationReason}).`,
        canResume: false,
        resumeHint: null,
        category: "error",
      };
  }
}

export function canResumeFromTerminationReason(reason: string): boolean {
  return getPatchUserFacingReason({ terminationReason: reason }).canResume;
}
