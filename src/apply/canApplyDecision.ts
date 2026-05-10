import type { RunAgentResult } from "../core/runAgent.js";
import type { ApplyEligibility } from "./types.js";

// Phase J.1: collapse preview_only / safe_to_apply into a single allowed-to-
// apply path. Only the "blocked" mode is non-applicable. Existing
// preview_only callers/serializations are still gated open here for
// back-compat — Phase J.5 cleanup will narrow the type.
export function canApplyDecision(result: RunAgentResult): ApplyEligibility {
  const mode = result.decision.mode;

  if (mode === "blocked") {
    return {
      allowed: false,
      reason: "blocked_mode",
      message: "Blocked decisions cannot be applied.",
    };
  }

  return {
    allowed: true,
    strategy: "confirmed_apply",
    message: "Decisions may be applied with explicit confirmation.",
  };
}
