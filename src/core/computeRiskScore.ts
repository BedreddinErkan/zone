import { computeRiskScoreDetails } from "./computeRiskScoreDetails.js";

export type RiskSignal =
  | "destructive"
  | "schema"
  | "critical_domain"
  | "low_risk";

export type ComputeRiskScoreResult = {
  score: number;
  signals: RiskSignal[];
  breakdown: {
    destructive: number;
    schema: number;
    critical: number;
    lowRisk: number;
  };
};

type ComputeRiskScoreInput = {
  task: string;
};

export function computeRiskScore(
  input: string | ComputeRiskScoreInput
): ComputeRiskScoreResult {
  const task = typeof input === "string" ? input : input.task;

  const details = computeRiskScoreDetails({ task });

  const signals: RiskSignal[] = [];

  if (details.riskBreakdown.destructive > 0) {
    signals.push("destructive");
  }

  if (details.riskBreakdown.schema > 0) {
    signals.push("schema");
  }

  if (details.riskBreakdown.critical > 0) {
    signals.push("critical_domain");
  }

  if (details.riskBreakdown.lowRisk < 0) {
    signals.push("low_risk");
  }

  return {
    score: details.riskScore,
    signals,
    breakdown: {
      destructive: details.riskBreakdown.destructive,
      schema: details.riskBreakdown.schema,
      critical: details.riskBreakdown.critical,
      lowRisk: details.riskBreakdown.lowRisk
    }
  };
}