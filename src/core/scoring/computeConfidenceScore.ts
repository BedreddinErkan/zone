type ConfidenceBreakdown = {
  base: number;
  destructivePenalty: number;
  schemaPenalty: number;
  criticalPenalty: number;
  massScopePenalty: number;
  lowRiskBonus: number;
};

type ComputeConfidenceScoreInput = {
  breakdown: {
    destructive: number;
    schema: number;
    critical: number;
    massScope: number;
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

function toPenalty(value: number): number {
  return value > 0 ? -value : 0;
}

function toBonus(value: number): number {
  return value < 0 ? Math.abs(value) : 0;
}

export function computeConfidenceScore(
  input: ComputeConfidenceScoreInput
): ComputeConfidenceScoreResult {
  const breakdown: ConfidenceBreakdown = {
    base: 100,
    destructivePenalty: toPenalty(input.breakdown.destructive),
    schemaPenalty: toPenalty(input.breakdown.schema),
    criticalPenalty: toPenalty(input.breakdown.critical),
    massScopePenalty: toPenalty(input.breakdown.massScope),
    lowRiskBonus: toBonus(input.breakdown.lowRisk)
  };

  const score = clamp(
    breakdown.base +
      breakdown.destructivePenalty +
      breakdown.schemaPenalty +
      breakdown.criticalPenalty +
      breakdown.massScopePenalty +
      breakdown.lowRiskBonus
  );

  return {
    score,
    breakdown
  };
}