import { computeRiskScoreDetails } from "./computeRiskScoreDetails.js";

export type RiskSignal =
  | "destructive"
  | "schema"
  | "critical_domain"
  | "low_risk"
  | "mass_scope";

export type ComputeRiskScoreResult = {
  score: number;
  signals: RiskSignal[];
  breakdown: {
    destructive: number;
    schema: number;
    critical: number;
    lowRisk: number;
    massScope: number;
  };
};

type ComputeRiskScoreInput = {
  task: string;
  role?: string;
};

export function computeRiskScore(
  input: string | ComputeRiskScoreInput
): ComputeRiskScoreResult {
  const task = typeof input === "string" ? input : input.task;
  const role = typeof input === "string" ? undefined : input.role;

  const details = computeRiskScoreDetails({ task });

  // Role-aware schema penalty adjustment:
  // test_engineer: writing tests is not a schema risk
  // data_analyst: schema changes are expected, handled separately
const schemaScore =
  role === "test_engineer" || role === "data_analyst" || role === "developer"
    ? 0
    : details.riskBreakdown.schema;

  const signals: RiskSignal[] = [];

  if (details.riskBreakdown.destructive > 0) signals.push("destructive");
  if (schemaScore > 0) signals.push("schema");
  if (details.riskBreakdown.critical > 0) signals.push("critical_domain");
  if (details.riskBreakdown.lowRisk < 0) signals.push("low_risk");
  if (details.riskBreakdown.massScope > 0) signals.push("mass_scope");

  const adjustedScore = Math.max(
    0,
    Math.min(
      100,
      details.riskBreakdown.destructive +
        schemaScore +
        details.riskBreakdown.critical +
        details.riskBreakdown.lowRisk +
        details.riskBreakdown.massScope
    )
  );

  return {
    score: adjustedScore,
    signals,
    breakdown: {
      destructive: details.riskBreakdown.destructive,
      schema: schemaScore,
      critical: details.riskBreakdown.critical,
      lowRisk: details.riskBreakdown.lowRisk,
      massScope: details.riskBreakdown.massScope,
    },
  };
}