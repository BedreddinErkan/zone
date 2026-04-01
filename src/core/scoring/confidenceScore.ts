import { computeConfidenceBreakdown } from "./computeConfidenceBreakdown.js";
import type { ComputeConfidenceBreakdownInput } from "./confidenceRules.js";

export function computeConfidenceScore(
  input: ComputeConfidenceBreakdownInput
): number {
  return computeConfidenceBreakdown(input).finalScore;
}