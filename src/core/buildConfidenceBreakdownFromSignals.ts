import { normalizeSignals } from "./normalizeSignals.js";

export type SignalConfidenceBreakdown = {
  destructive: number;
  schema: number;
  critical: number;
  massScope: number;
  lowRisk: number;
};

export function buildConfidenceBreakdownFromSignals(
  signals: string[]
): SignalConfidenceBreakdown {
  const normalized = normalizeSignals(signals);

  const breakdown: SignalConfidenceBreakdown = {
    destructive: 0,
    schema: 0,
    critical: 0,
    massScope: 0,
    lowRisk: 0
  };

  for (const signal of normalized) {
    if (signal.type === "destructive") {
      breakdown.destructive = Math.abs(signal.confidenceImpact);
    }

    if (signal.type === "schema") {
      breakdown.schema = Math.abs(signal.confidenceImpact);
    }

    if (signal.type === "critical_domain") {
      breakdown.critical = Math.abs(signal.confidenceImpact);
    }

    if (signal.type === "mass_scope") {
      breakdown.massScope = Math.abs(signal.confidenceImpact);
    }
  }

  if (signals.includes("low_risk")) {
    breakdown.lowRisk = -20;
  }

  return breakdown;
}