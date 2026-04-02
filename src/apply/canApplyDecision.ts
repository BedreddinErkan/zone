import type { RunAgentResult } from "../core/runAgent.js";
import type { ApplyEligibility } from "./types.js";

export function canApplyDecision(result: RunAgentResult): ApplyEligibility {
  const mode = result.decision.mode;

  if (mode === "blocked") {
    return {
      allowed: false,
      reason: "blocked_mode",
      message: "Blocked decisions cannot be applied."
    };
  }

  if (mode === "preview_only") {
    return {
      allowed: true,
      strategy: "confirmed_apply",
      message:
        "Preview-only decisions may be applied only with explicit confirmation."
    };
  }

  return {
    allowed: true,
    strategy: "confirmed_apply",
    message:
      "Safe-to-apply decisions may be applied with explicit confirmation."
  };
}