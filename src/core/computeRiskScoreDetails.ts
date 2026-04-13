import type { RiskBreakdown, RiskScoreDetails } from "./types/risk";

type ComputeRiskScoreDetailsInput = {
  task: string;
};

function logRiskDebug(label: string, payload: Record<string, unknown>): void {
  console.log(`[zone-debug] ${label}: ${JSON.stringify(payload)}`);
}

function clampScore(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function hasContextualSoftDestructiveSignal(text: string): boolean {
  const softDestructiveKeywords = ["clear", "reset", "clean"];
  const destructiveObjectKeywords = [
    "cache",
    "session",
    "sessions",
    "token",
    "tokens",
    "database",
    "db",
    "table",
    "tables",
    "record",
    "records",
    "row",
    "rows",
    "data",
    "user",
    "users",
    "storage",
    "queue",
    "queues",
  ];

  return (
    includesAny(text, softDestructiveKeywords) &&
    includesAny(text, destructiveObjectKeywords)
  );
}

function scoreWeightedKeywordMatches(
  text: string,
  weightedKeywords: Array<{ keywords: string[]; weight: number }>
): number {
  let maxWeight = 0;
  for (const entry of weightedKeywords) {
    if (includesAny(text, entry.keywords)) {
      maxWeight = Math.max(maxWeight, entry.weight);
    }
  }
  return maxWeight;
}

function hasSchemaContextExemption(text: string): boolean {
  return includesAny(text, ["test", "mock", "fixture", "seed"]);
}

function isSchemaKeywordPrecededByTestOrMock(
  text: string,
  keyword: string
): boolean {
  const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:test|mock)\\s+${escapedKeyword}\\b`).test(text);
}

export function computeRiskScoreDetails(
  input: ComputeRiskScoreDetailsInput
): RiskScoreDetails {
  const normalizedTask = input.task.trim().toLowerCase();

  const destructiveWeight = Math.max(
    scoreWeightedKeywordMatches(normalizedTask, [
      {
        keywords: ["truncate", "drop table", "delete all", "wipe", "purge"],
        weight: 1.0,
      },
      {
        keywords: ["delete", "remove", "destroy", "drop"],
        weight: 0.7,
      },
    ]),
    hasContextualSoftDestructiveSignal(normalizedTask) ? 0.4 : 0
  );

  const schemaHighWeightKeywords = [
    "migration",
    "migrate",
    "alter table",
    "drop column",
    "add column",
  ];
  const hasHighWeightSchemaSignal = schemaHighWeightKeywords.some(
    (keyword) =>
      normalizedTask.includes(keyword) &&
      !isSchemaKeywordPrecededByTestOrMock(normalizedTask, keyword)
  );
  const highWeightSchemaScore = hasHighWeightSchemaSignal ? 25 : 0;
  const reducedSchemaScore = hasSchemaContextExemption(normalizedTask)
    ? 0
    : scoreWeightedKeywordMatches(normalizedTask, [
        {
          keywords: ["schema", "database", "db", "column", "table"],
          weight: 0.6,
        },
      ]) * 25;

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

  const hasDestructiveSignal = destructiveWeight > 0;
  const hasSchemaSignal = highWeightSchemaScore > 0 || reducedSchemaScore > 0;
  const hasScopeWord = includesAny(normalizedTask, [
    "all",
    "every",
    "entire",
    "whole"
  ]);
  const hasMassScopeSignal = hasDestructiveSignal && hasScopeWord;

  const riskBreakdown: RiskBreakdown = {
    destructive: Math.round(50 * destructiveWeight),
    schema: Math.max(highWeightSchemaScore, Math.round(reducedSchemaScore)),
    critical: hasCriticalSignal ? 20 : 0,
    lowRisk: hasLowRiskSignal ? -20 : 0,
    massScope: hasMassScopeSignal ? 40 : 0
  };

  let compoundPenalty = 0;
  if (riskBreakdown.destructive > 0 && riskBreakdown.massScope > 0) {
    compoundPenalty += 20;
  }
  if (riskBreakdown.destructive > 0 && riskBreakdown.critical > 0) {
    compoundPenalty += 15;
  }
  // auth + JWT/token combination = elevated critical
  if (hasCriticalSignal && (
    normalizedTask.includes("jwt") ||
    normalizedTask.includes("token") ||
    normalizedTask.includes("middleware")
  )) {
    compoundPenalty += 15;
  }

  const rawScore =
    riskBreakdown.destructive +
    riskBreakdown.schema +
    riskBreakdown.critical +
    riskBreakdown.lowRisk +
    riskBreakdown.massScope +
    compoundPenalty;

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

  if (hasMassScopeSignal) {
    detectedSignals.push("mass_scope");
  }

  logRiskDebug("computeRiskScoreDetails result", {
    task: input.task,
    normalizedTask,
    destructiveWeight,
    hasCriticalSignal,
    hasLowRiskSignal,
    hasSchemaSignal,
    hasScopeWord,
    hasMassScopeSignal,
    riskBreakdown,
    detectedSignals,
    compoundPenalty,
    riskScore,
  });

  return {
    riskScore,
    riskBreakdown,
    detectedSignals,
    compoundPenalty
  };
}
