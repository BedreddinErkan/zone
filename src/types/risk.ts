// src/core/types/risk.ts

export type RiskBreakdown = {
  destructive: number;
  schema: number;
  critical: number;
  lowRisk: number;
  massScope: number;
};

export type RiskScoreDetails = {
  riskScore: number;
  riskBreakdown: RiskBreakdown;
  detectedSignals: string[];
  compoundPenalty: number;
};