type ConfidenceBreakdown = {
  base: number;
  destructivePenalty: number;
  schemaPenalty: number;
  criticalPenalty: number;
  lowRiskBonus: number;
};

type ComputeConfidenceScoreInput = {
  breakdown: {
    destructive: number;
    schema: number;
    critical: number;
    lowRisk: number;
  };
};

type ComputeConfidenceScoreResult = {
  score: number;
  breakdown: ConfidenceBreakdown;
};

function clamp(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export function computeConfidenceScore(
  input: ComputeConfidenceScoreInput
): ComputeConfidenceScoreResult {
  const breakdown: ConfidenceBreakdown = {
    base: 100,
    destructivePenalty:
      input.breakdown.destructive > 0 ? -input.breakdown.destructive : 0,
    schemaPenalty: input.breakdown.schema > 0 ? -input.breakdown.schema : 0,
    criticalPenalty:
      input.breakdown.critical > 0 ? -input.breakdown.critical : 0,
    lowRiskBonus: input.breakdown.lowRisk < 0 ? Math.abs(input.breakdown.lowRisk) : 0
  };

  const score = clamp(
    breakdown.base +
      breakdown.destructivePenalty +
      breakdown.schemaPenalty +
      breakdown.criticalPenalty +
      breakdown.lowRiskBonus
  );

  return {
    score,
    breakdown
  };
}