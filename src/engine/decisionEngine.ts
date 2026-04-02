import { detectContradictions } from "./contradictionDetector.js";
import type { ContradictionFlag, ExecutionMode } from "./contradictionDetector.js";

export type { ContradictionFlag, ExecutionMode };

export interface DecisionEngineInput {
  /** Normalized risk score in [0, 1] range. */
  riskScore: number;
  /** Normalized confidence score in [0, 1] range. */
  confidenceScore: number;
  /** The resolved execution mode. */
  mode: ExecutionMode;
}

export interface DecisionEngineResult {
  riskScore: number;
  confidenceScore: number;
  mode: ExecutionMode;
  contradictionFlags: ContradictionFlag[];
}

/**
 * Runs the decision engine: evaluates scores and mode for semantic contradictions.
 * Does not alter scoring logic — purely additive contradiction layer.
 */
export function runDecisionEngine(
  input: DecisionEngineInput
): DecisionEngineResult {
  const { riskScore, confidenceScore, mode } = input;

  const contradictionFlags = detectContradictions(
    riskScore,
    confidenceScore,
    mode
  );

  return {
    riskScore,
    confidenceScore,
    mode,
    contradictionFlags,
  };
}
