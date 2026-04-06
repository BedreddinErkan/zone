import type {
  SemanticRisk,
  SemanticRiskScore,
  SemanticRiskSeverity,
} from "./semanticRiskTypes.js";

const severityScores: Record<SemanticRiskSeverity, number> = {
  low: 10,
  medium: 40,
  high: 70,
  critical: 100,
};

const severityOrder: SemanticRiskSeverity[] = [
  "low",
  "medium",
  "high",
  "critical",
];

export function scoreSemanticRisk(risks: SemanticRisk[]): SemanticRiskScore {
  const countsBySeverity: Record<SemanticRiskSeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  let totalScore = 0;
  let highestSeverity: SemanticRiskSeverity = "low";

  for (const risk of risks) {
    countsBySeverity[risk.severity] += 1;
    totalScore += severityScores[risk.severity];

    if (
      severityOrder.indexOf(risk.severity) >
      severityOrder.indexOf(highestSeverity)
    ) {
      highestSeverity = risk.severity;
    }
  }

  return {
    totalScore,
    highestSeverity,
    countsBySeverity,
  };
}
