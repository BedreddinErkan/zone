export type ContradictionFlagType =
  | "LOW_CONFIDENCE_ON_SAFE"
  | "HIGH_CONFIDENCE_ON_BLOCK"
  | "SCORE_TENSION";

export type ContradictionSeverity = "info" | "warning" | "critical";

export interface ContradictionFlag {
  type: ContradictionFlagType;
  severity: ContradictionSeverity;
  message: string;
}

export type ExecutionMode = "safe_to_apply" | "preview_only" | "blocked";

/**
 * Detects semantic inconsistencies between riskScore, confidenceScore, and executionMode.
 *
 * @param riskScore     - Normalized risk score in [0, 1] range.
 * @param confidenceScore - Normalized confidence score in [0, 1] range.
 * @param mode          - The resolved execution mode.
 * @returns An array of ContradictionFlag. Empty if no contradictions detected.
 */
export function detectContradictions(
  riskScore: number,
  confidenceScore: number,
  mode: ExecutionMode
): ContradictionFlag[] {
  const flags: ContradictionFlag[] = [];

  // LOW_CONFIDENCE_ON_SAFE: mode is safe but confidence is too low to justify it
  if (mode === "safe_to_apply" && confidenceScore < 0.4) {
    flags.push({
      type: "LOW_CONFIDENCE_ON_SAFE",
      severity: "warning",
      message: `Safe execution mode was decided but confidence score is below threshold (${confidenceScore.toFixed(2)}). The decision may not be well-supported.`,
    });
  }

  // HIGH_CONFIDENCE_ON_BLOCK: mode is blocked but risk score is too low to explain the block
  if (mode === "blocked" && riskScore < 0.3) {
    flags.push({
      type: "HIGH_CONFIDENCE_ON_BLOCK",
      severity: "info",
      message: `Execution was blocked but risk score is below threshold (${riskScore.toFixed(2)}). The block is likely driven by validation issues rather than semantic risk.`,
    });
  }

  // SCORE_TENSION: high risk + high confidence + safe mode is a contradictory combination
  if (riskScore > 0.6 && confidenceScore > 0.8 && mode === "safe_to_apply") {
    flags.push({
      type: "SCORE_TENSION",
      severity: "critical",
      message: `Risk score (${riskScore.toFixed(2)}) and confidence score (${confidenceScore.toFixed(2)}) are both elevated while mode is safe_to_apply. This combination is semantically inconsistent.`,
    });
  }

  return flags;
}
