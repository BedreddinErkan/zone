import type { RiskBreakdown, RiskScoreDetails } from "./types/risk";

type ComputeRiskScoreDetailsInput = {
  task: string;
};

function clampScore(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

export function computeRiskScoreDetails(
  input: ComputeRiskScoreDetailsInput
): RiskScoreDetails {
  const normalizedTask = input.task.trim().toLowerCase();

  const hasDestructiveSignal = includesAny(normalizedTask, [
    "delete",
    "drop",
    "remove",
    "destroy",
    "truncate"
  ]);

  const hasSchemaSignal = includesAny(normalizedTask, [
    "schema",
    "migration",
    "migrate",
    "database",
    "db",
    "column",
    "columns",
    "table",
    "tables",
    "field",
    "fields",
    "model",
    "models"
  ]);

  const hasCriticalSignal = includesAny(normalizedTask, [
    "auth",
    "authentication",
    "authorization",
    "billing",
    "payment",
    "payments",
    "permission",
    "permissions",
    "security",
    "jwt",
    "token",
    "production"
  ]);

  const hasLowRiskSignal = includesAny(normalizedTask, [
    "copy",
    "text",
    "rename",
    "comment",
    "docs",
    "readme"
  ]);

  const riskBreakdown: RiskBreakdown = {
    destructive: hasDestructiveSignal ? 50 : 0,
    schema: hasSchemaSignal ? 25 : 0,
    critical: hasCriticalSignal ? 20 : 0,
    lowRisk: hasLowRiskSignal ? -20 : 0
  };

  const rawScore =
    riskBreakdown.destructive +
    riskBreakdown.schema +
    riskBreakdown.critical +
    riskBreakdown.lowRisk;

  const riskScore = clampScore(rawScore);

  const detectedSignals: string[] = [];

  if (hasDestructiveSignal) {
    detectedSignals.push("destructive");
  }

  if (hasSchemaSignal) {
    detectedSignals.push("schema_change");
  }

  if (hasCriticalSignal) {
    detectedSignals.push("critical_domain");
  }

  if (hasLowRiskSignal) {
    detectedSignals.push("low_risk");
  }

  return {
    riskScore,
    riskBreakdown,
    detectedSignals
  };
}